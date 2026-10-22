// The test runner injects `browser`, `$`, `$$` and `expect` as globals and the
// `WebdriverIO.*` namespace (used by wdio.conf.ts) comes from `@wdio/globals`.
// That package is a transitive dependency of `@wdio/cli`, which pnpm does not
// expose at the root of `node_modules`, so load it through pnpm's hidden hoist
// directory instead of `types: ["@wdio/globals/types"]`. The file is a global
// script (no top-level import/export), so its declarations stay global.
import "../../node_modules/.pnpm/node_modules/@wdio/globals/types";
