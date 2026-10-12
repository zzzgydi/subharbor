# Contributing

Use Node 24 LTS and pnpm 11.21. Run type checking, tests and a production build before proposing changes. Add synthetic protocol fixtures rather than real subscription credentials. Configuration names must never trigger behavior.

Input adapters and output adapters have separate responsibilities. When adding protocol fields, document which target/version supports them and add round-trip or rejection coverage. Unsupported security or transport parameters must not be silently dropped.

Do not copy GPL/AGPL implementation code into this MIT project without first resolving the licensing strategy. Third-party rule data retains its original terms and attribution.
