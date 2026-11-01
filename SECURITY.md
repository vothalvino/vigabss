# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Include the affected version or commit, the steps
to reproduce, and the impact you observed.

You should get an acknowledgement within a week. Fixes for confirmed issues
are released as soon as they are ready; the advisory is published once
operators have had time to upgrade.

## Supported versions

VigaBSS is pre-1.0 (`0.1.0-alpha`). Only the latest `main` and the most recent
release tag receive security fixes.

## How dependencies are watched

- Every pull request and every push to `main` scans the lockfile with Trivy,
  and the container image built for that commit is scanned before it is
  published. A fixable HIGH or CRITICAL finding blocks the merge or the
  publish.
- `.github/workflows/security-scan.yml` re-scans the lockfile and the
  published `latest` image every Monday and opens an issue when it finds a
  blocking vulnerability, because advisories appear between commits.
- Results are published to the repository's code-scanning alerts.
- Dependabot opens weekly update pull requests for npm packages, GitHub
  Actions and the Docker base image.
- `.trivyignore` entries need a written rationale, a removal condition and an
  `exp:` date, after which the finding is reported again.
