# Provenance and release review

The requested architectural reference was [ArcaneCastersInfra](https://github.com/Apptive-Game-Team/ArcaneCastersInfra), dev revision `d8c2011fe4c5a3218819f4ad9ed5f9dd50ee01f8` inspected on 2026-10-19. Its LICENSE reserves all rights and grants no permission to use, copy, modify, distribute or run its code/assets without prior written permission.

No reference source, configuration, assets, deployment identifiers, credentials, or git history are included here. This project is an original implementation of the general deployment lifecycle requested by the user. It deliberately uses a newly specified admission contract and explicit container definitions instead of porting the reference scripts. The reference was not executed or modified.

The MIT license in this project applies only to this project's original files. It does not grant rights over the organization repository. Reusing any organization-owned source would require the copyright holder's written permission and a separate provenance review. Public visibility alone is not such permission.

Before a stable release, complete real Docker and application integration validation, review dependency/toolchain provenance and security reporting settings, and audit published files for secrets. The initial package is marked private to prevent accidental npm publication; GitHub source publication does not publish a package or registry image.
