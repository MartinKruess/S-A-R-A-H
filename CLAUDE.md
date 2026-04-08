# S.A.R.A.H. — Project Rules

## Git Workflow
- New branch for every feature (`feat/`, `fix/`, `refactor/`)
- PRs always target `dev`, never `main` directly
- Squash merge PRs for clean history
- Push and create PR when a feature is complete
- Delete merged branches locally and on GitHub
- Conventional Commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`

## Code Standards
- TypeScript: never use `unknown`, `never`, or `any` unless absolutely unavoidable
- Use project-global resources (shared types, components, CSS custom properties)
- Use Context7 for library/framework documentation lookups
- Language: code and commits in English, UI text in German
