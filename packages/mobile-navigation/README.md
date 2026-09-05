# Mobile navigation

This package owns the React Navigation integration used by the native app. Its
peer versions match the React Native host; browser validation must not merge
this dependency realm with desktop React packages.

Navigation 7.21.13 still imports query-string as a namespace. Query-string 9
exports its API as a default export and uses the patched URI decoder. The
four-line patch migrates the two imports in source and published JavaScript;
parsing and navigation behavior remain upstream implementations. This is the
same import form used by Navigation's next major release.

Keep the exact core version, patch, query-string override, and native host's
`apps/mobile` dependencies and pnpm policy aligned. Remove the patch and exact
core override when a stable Navigation release adopts query-string 9 itself.

References:

- https://github.com/react-navigation/react-navigation/blob/main/packages/core/src/getStateFromPath.tsx
- https://github.com/sindresorhus/query-string/releases/tag/v8.0.0
