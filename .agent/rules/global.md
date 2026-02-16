---
trigger: always_on
---

# React & Next.js Professional Standards

## Context

Whenever the user asks to write, refactor, or review React or Next.js code, you must leverage the specialized knowledge stored in your skills library.

## Instructions

1. **Lookup Requirement**: Before generating code, search the `react-best-practices.md` skill for relevant patterns (e.g., RSC, Data Fetching, Memoization).
2. **Prioritize Performance**: Strictly follow the "Vercel Labs" standards for:
   - Avoiding Request Waterfalls (use parallel fetching).
   - Optimizing Server Components vs. Client Components.
   - Using `React.cache()` and `next/dynamic`.
3. **Code Review Protocol**: If a user's code violates a best practice found in the skill, point it out and provide the optimized version.

## Key Directives (Shortcuts)

- **Parallelize**: Use `Promise.all()` for independent fetches.
- **RSC First**: Keep components on the server unless interactivity is required.
- **No Barrels**: Avoid barrel files to prevent slow dev-server performance.
