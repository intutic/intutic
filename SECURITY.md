# Intutic Security Policy

At Intutic, security and governance for AI coding agents are at the core of our platform. We appreciate the security community's work in disclosing vulnerabilities responsibly.

---

## 🛡️ Supported Versions

We provide security updates and patches for the following versions of Intutic packages, CLI tools, and proxy binaries:

| Version | Supported | Description / Patch SLA |
| :--- | :---: | :--- |
| `1.5.x` (Latest) | :white_check_mark: | **Active Support** — Current stable production release line. Critical security patches within 24–48 hours. |
| `< 1.5.0` | :x: | **Unsupported / Pre-release** — Legacy or pre-release iterations. Users should upgrade to `1.5.x`. |

---

## 🔒 Reporting a Vulnerability

**Please do NOT report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability or security policy bypass in Intutic (including the proxy gateway, CLI tools, sync daemon, or control plane), please report it to our team privately:

* **Primary Email:** [support@intutic.ai](mailto:support@intutic.ai)
* **GitHub Private Advisory:** Click on the **"Report a vulnerability"** button under the repository's [Security Tab](https://github.com/intutic/intutic/security/advisories/new).

### Information to Include in Your Report
To help us triage and fix the vulnerability efficiently, please include:
1. Type of issue (e.g. proxy sandbox escape, token leakage, DLP bypass, command injection).
2. Step-by-step instructions or proof-of-concept (PoC) code to reproduce the issue.
3. Affected components (e.g. `@intutic/cli`, `packages/proxy`, `services/control-plane`).
4. Potential impact of the vulnerability.

---

## ⏱️ Response & Triage SLA

When you submit a vulnerability report:
* **Initial Acknowledgment:** Within **24 hours** of receipt.
* **Triage & Classification:** Within **48 hours**, confirming validity and severity level (CVSS v3).
* **Patch Deployment:** 
  * **Critical / High:** Patched within **72 hours** across NPM packages, GKE deployments, and release binaries.
  * **Medium / Low:** Addressed in the next planned minor/patch release cycle.
* **Public Disclosure:** Once a fix is verified and deployed, we coordinate public advisory release and attribution with the reporter.

---

## ⚖️ Responsible Disclosure Guidelines

We ask that all security researchers:
* Give us reasonable time to investigate and mitigate an issue before public disclosure.
* Avoid accessing or modifying customer/user data without authorization.
* Act in good faith to avoid service disruption or data destruction.
