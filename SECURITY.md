# Security

Docker control is effectively host-administrator access. Run this tool only on a trusted deployment host, with an explicitly reviewed Docker context. Do not expose the Docker socket or mount it into untrusted applications. Registry login is an operator responsibility; the tool neither creates credentials nor logs tokens or container environments.

Protect config, env files and state with OS permissions. POSIX file modes are advisory on Windows: configure ACLs. All management URLs receive the configured bearer token, so use only endpoints you control. TLS is the default requirement; `allowHttp` exists for a private local lab. Do not expose readiness/drain/controller endpoints publicly. Prefer separate application and management listeners in your integration.

Review images and tags before enabling polling; a compromised registry account can run arbitrary image code. Pin digests when automatic tag tracking is inappropriate. The minimal runtime drops capabilities and enables no-new-privileges, but it is not a sandbox for hostile images. Set a non-root USER in application images.

HTTP and Docker errors intentionally omit remote response bodies and subprocess output. Avoid logging application credentials during manual investigation. Config parser errors may identify field names; do not embed secrets in config. Never commit env files, registry configuration, real host inventories or logs.

Shutdown hooks are trusted operator code/requests. They run only on explicitly configured, ownership-checked slots; never populate hook configuration from untrusted labels. Exec runs inside the app container, without implicit shell evaluation. Stdin uses original-process attachment and is limited to local Unix Docker sockets. Timeouts can leave uncertain remote side effects: keep the journal and reconcile. The optional force-stop policy trades preservation of in-flight work for termination; it is never the default.

Report suspected vulnerabilities privately to the repository maintainer through an available private GitHub reporting channel. Do not attach credentials or exploit details to a public issue. There is no staffed security response SLA.
