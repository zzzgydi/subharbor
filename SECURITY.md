# Security

Report security issues privately to the repository maintainer before public disclosure. An official contact will be added when the public repository is created.

Subscription URLs and generated configurations contain access credentials. Do not paste them into public issues or logs. Backup files are encrypted but must still be treated as private. Store the encryption key separately.

Only the administrator may configure scripts. QuickJS exposes no host capabilities and runs in a separate process with time and memory limits. This is not a multi-tenant execution service. Keep the runtime dependencies patched.

Do not cache subscription URLs in public CDNs. The example reverse proxy disables raw access logs for `/sub/`. Use TLS and configure trusted proxy addresses explicitly.
