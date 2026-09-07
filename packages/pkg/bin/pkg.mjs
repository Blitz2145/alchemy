#!/usr/bin/env node
// Launcher for the published `pkg` bin. The compiled entry only exists after
// `pnpm build`; this file is checked in so package managers can create the
// bin shim at install time. In a checkout run the source directly:
//   bun packages/pkg/src/cli/bin.ts <command>
import "../lib/cli/bin.js";
