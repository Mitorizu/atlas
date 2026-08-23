import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, join } from 'node:path';
import { createRustParser, rustNodeTypes, type NodeTypeInfo, type Parser } from '../src/parser.ts';
import { REQUIRED_NODES, TURBOFISH_NODE, MUTABILITY_MARKER } from '../src/dialects/bevy-0.19/grammar-contract.ts';
import { verifyContract } from '../scripts/grammar-report.ts';
import { findBevyExamples, rustFilesUnder } from './corpus.ts';

describe('M0: toolchain ABI', () => {
  test('tree-sitter 0.25 loads the 0.24 Rust grammar and parses', () => {
    const tree = createRustParser().parse('fn setup(mut commands: Commands) {}');
    assert.equal(tree.rootNode.type, 'source_file');
    assert.equal(tree.rootNode.hasError, false);
    assert.equal(tree.rootNode.firstChild?.type, 'function_item');
  });

  test('grammar exposes node-type metadata', () => {
    const types = rustNodeTypes();
    assert.ok(types.length > 200, `expected a full grammar, got ${types.length} node types`);
  });

  test('Query API is available (pass 3 depends on S-expression queries)', async () => {
    const { default: Parser } = await import('tree-sitter');
    assert.equal(typeof (Parser as unknown as { Query: unknown }).Query, 'function');
  });
});

describe('M0: grammar contract', () => {
  test('every node kind and field the dialect needs exists in the grammar', () => {
    assert.deepEqual(verifyContract(rustNodeTypes()), []);
  });

  test('verifier actually detects violations', () => {
    const withoutFunctionItem = rustNodeTypes().filter((t) => t.type !== 'function_item');
    const missingNode = verifyContract(withoutFunctionItem);
    assert.ok(
      missingNode.some((v) => v.node === 'function_item' && v.kind === 'missing-node'),
      'removing function_item should be reported',
    );

    const stripped: NodeTypeInfo[] = rustNodeTypes().map((t) =>
      t.type === 'parameter' ? { ...t, fields: {} } : t,
    );
    const missingField = verifyContract(stripped);
    assert.ok(
      missingField.some((v) => v.node === 'parameter' && v.field === 'type'),
      'removing parameter.type should be reported',
    );
  });

  test('contract covers the constructs DESIGN.md names', () => {
    for (const n of ['generic_type', 'reference_type', 'tuple_type', TURBOFISH_NODE, MUTABILITY_MARKER]) {
      assert.ok(n in REQUIRED_NODES, `${n} must be in the contract`);
    }
  });
});

describe('M0: observed AST shapes', () => {
  const parse = (src: string) => createRustParser().parse(src).rootNode;
  const sexp = (src: string) => parse(src).toString();

  test('&mut T carries mutable_specifier; &T does not', () => {
    assert.match(sexp('fn s(q: Query<&mut Transform>) {}'), /reference_type \(mutable_specifier\)/);
    assert.doesNotMatch(sexp('fn s(q: Query<&Transform>) {}'), /reference_type \(mutable_specifier\)/);
  });

  test('Query<D, F> exposes data and filter tuples as tuple_type', () => {
    const s = sexp('fn s(q: Query<(&mut A, &B), (With<P>, Without<D>)>) {}');
    assert.equal((s.match(/tuple_type/g) ?? []).length, 2);
  });

  test('Option<&T> nests a reference_type inside generic_type', () => {
    assert.match(
      sexp('fn s(q: Query<(&mut A, Option<&V>)>) {}'),
      /generic_type type: \(type_identifier\) type_arguments: \(type_arguments \(reference_type type:/,
    );
  });

  test('a modifier on a tuple is a field_expression over a tuple_expression (§7.6)', () => {
    // `.chain()` applied to `(b, d)` must be distinguishable from `.chain()` on a single system.
    assert.match(
      sexp('fn m(){ app.add_systems(Update, (a, (b, d).chain())); }'),
      /field_expression value: \(tuple_expression/,
    );
    assert.doesNotMatch(
      sexp('fn m(){ app.add_systems(Update, a.chain()); }'),
      /field_expression value: \(tuple_expression/,
    );
  });

  test('turbofish registration is a distinct generic_function node (§6.2)', () => {
    assert.match(
      sexp('fn m(){ app.add_systems(Update, trigger::<RightSprite>); }'),
      new RegExp(`${TURBOFISH_NODE} function: \\(identifier\\) type_arguments:`),
    );
  });
});

describe('M0: real corpus', () => {
  const dir = findBevyExamples();
  const skip = dir ? false : 'bevy 0.19 corpus not in cargo cache';

  /**
   * tree-sitter-rust 0.24.0 cannot parse `#[cfg(...)]` in expression position. It degrades
   * deterministically to ERROR("#") + array_expression("[cfg(...)]"). Recovery is local, so
   * the enclosing item and registration still parse. Two further constructs also fail.
   * See DESIGN.md §7.6.
   */
  const classify = (src: string, root: Parser.SyntaxNode): string => {
    const errs: string[] = [];
    const walk = (n: Parser.SyntaxNode): void => {
      if (n.type === 'ERROR') errs.push(src.slice(n.startIndex, n.endIndex + 40));
      for (const c of n.children) walk(c);
    };
    walk(root);
    const joined = errs.join('\n');
    if (/#\s*\[?\s*cfg/.test(joined)) return 'cfg-in-expression';
    if (/::<\s*-/.test(joined) || /-\d+>/.test(joined)) return 'negative-const-generic';
    if (/\|/.test(joined)) return 'closure-form';
    return 'UNKNOWN';
  };

  test('parse failures are bounded and all have known causes', { skip }, () => {
    const parser = createRustParser();
    const files = rustFilesUnder(dir!, 10_000);
    assert.ok(files.length > 400, `expected the full corpus, found ${files.length}`);

    const causes = new Map<string, string[]>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const tree = parser.parse(src);
      if (!tree.rootNode.hasError) continue;
      const cause = classify(src, tree.rootNode);
      (causes.get(cause) ?? causes.set(cause, []).get(cause)!).push(relative(dir!, file));
    }

    const failed = [...causes.values()].reduce((n, v) => n + v.length, 0);
    assert.ok(failed / files.length < 0.05, `parse failure rate regressed to ${failed}/${files.length}`);
    assert.deepEqual(causes.get('UNKNOWN') ?? [], [], 'a new, unclassified parse failure appeared');
  });

  test('error recovery is local: items and registrations survive a cfg failure', { skip }, () => {
    const file = join(dir!, '3d', '3d_shapes.rs');
    const src = readFileSync(file, 'utf8');
    const root = createRustParser().parse(src).rootNode;
    assert.equal(root.hasError, true, 'fixture must still be a cfg-broken file');

    // Every `fn` in the source still yields a function_item.
    let items = 0;
    const walk = (n: Parser.SyntaxNode, fn: (n: Parser.SyntaxNode) => void): void => {
      fn(n);
      for (const c of n.children) walk(c, fn);
    };
    walk(root, (n) => { if (n.type === 'function_item') items++; });
    assert.equal(items, (src.match(/^\s*(pub )?fn /gm) ?? []).length);

    // The add_systems registration and its tuple members still parse.
    let tupleMembers: string[] = [];
    walk(root, (n) => {
      if (n.type !== 'call_expression') return;
      const f = n.childForFieldName('function');
      if (f?.type !== 'field_expression' || f.childForFieldName('field')?.text !== 'add_systems') return;
      const tuple = n.childForFieldName('arguments')?.namedChildren.find((c) => c.type === 'tuple_expression');
      if (tuple) tupleMembers = tuple.namedChildren.map((c) => c.type);
    });
    assert.ok(tupleMembers.includes('call_expression'), 'real systems must survive');
    assert.ok(tupleMembers.includes('identifier'), 'bare system must survive');
    // ...and the mangled cfg is present as the documented artifact, which pass 3 must skip.
    assert.ok(
      tupleMembers.includes('ERROR') && tupleMembers.includes('array_expression'),
      `cfg artifact shape changed: ${tupleMembers.join(',')}`,
    );
  });
});
