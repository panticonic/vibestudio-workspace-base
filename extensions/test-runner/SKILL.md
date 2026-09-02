---
name: workspace-native-test-adapter
description: Run explicitly native workspace test suites through the context-aware verify tool.
---

# Workspace Native Test Adapter

Use `verify`, never invoke this extension directly:

```ts
verify({
  operation: "test",
  target: "extensions/test-runner",
  suite: "native",
  file: "index.test.ts",
});
```

The unit manifest must declare the named suite with `runtime: "native"`.
Only that declaration routes here and requests `native.code.execute-tests`.
The adapter rechecks the declaration against the exact materialized context,
then launches Vitest in a fresh Node child with an allow-listed environment,
read access limited to that context/dependency closure, and a fresh writable
scratch directory. It never imports selected workspace modules into the
long-lived extension process.

Browser and workerd suites do not use this extension and do not request native
approval. A compatibility or build failure never falls back to this adapter.
