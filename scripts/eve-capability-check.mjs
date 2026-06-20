#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const requiredFiles = [
  "agent/agent.ts",
  "agent/instructions.md",
  "agent/skills/vidux/SKILL.md",
  "agent/skills/auto/SKILL.md",
  "agent/skills/moussey/SKILL.md",
  "agent/skills/resplit-currency-api/SKILL.md",
  "agent/skills/glm-local/SKILL.md",
  "agent/subagents/fx-readiness/agent.ts",
  "agent/subagents/fx-readiness/instructions.md",
  "RALPH.md",
  "AGENTS.md",
  ".cursor/plans/resplit-nurse.log.md",
  ".github/workflows/run.yml",
  "RUNBOOK.md",
  "INBOX.md",
  "vidux/pre-launch-architecture/PLAN.md",
  "package.json",
  "package-lock.json",
  "scripts/validate-package.js",
  "scripts/smoke-check-deploy.js",
];

const requiredScripts = [
  "eve:info",
  "eve:build",
  "eve:dev:local",
  "eve:capabilities",
];

const requiredDeps = {
  ai: "7.0.0-beta.178",
  eve: "0.11.5",
  zod: "4.4.3",
};

const expectedBranchFragments = [
  "codex/eve-studio-resplit-currency-api-20260620",
];

const forbiddenFiles = [
  ".env.local",
  ".dev.vars",
];

const forbiddenTokens = [
  "eve link",
  "eve deploy",
  "wrangler deploy",
  "gcloud run deploy",
  "terraform apply",
  "gh workflow run",
  "AI_GATEWAY_API_KEY=",
  "ANTHROPIC_API_KEY=",
  "GLM_API_KEY=",
  "CLOUDFLARE_API_TOKEN=",
  "GOOGLE_APPLICATION_CREDENTIALS=",
];

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), "utf8"));
}

function exists(relPath) {
  return fs.existsSync(path.join(root, relPath));
}

function readText(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function gitStatus() {
  try {
    return execFileSync("git", ["status", "--short", "--branch"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "git_status_unavailable";
  }
}

const errors = [];
const warnings = [];

for (const file of requiredFiles) {
  if (!exists(file)) errors.push(`Missing required file: ${file}`);
}

for (const file of forbiddenFiles) {
  if (exists(file)) errors.push(`Forbidden credential/local env file exists: ${file}`);
}

const packageJson = readJson("package.json");
for (const script of requiredScripts) {
  if (!packageJson.scripts?.[script]) errors.push(`Missing package script: ${script}`);
}

for (const [name, version] of Object.entries(requiredDeps)) {
  const actual = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
  if (actual !== version) errors.push(`Dependency ${name} must be ${version}, got ${actual ?? "missing"}`);
}

const searchable = requiredFiles.filter(
  (file) => exists(file) && file.startsWith("agent/") && file.endsWith(".md"),
);
for (const file of searchable) {
  const text = readText(file);
  for (const token of forbiddenTokens) {
    if (text.includes(token)) errors.push(`${file} contains forbidden token: ${token}`);
  }
}

const status = gitStatus();
if (!expectedBranchFragments.some((fragment) => status.includes(fragment))) {
  warnings.push(`Expected clean Eve worktree branch name was not detected: ${expectedBranchFragments.join(" or ")}`);
}

const report = {
  ok: errors.length === 0,
  verdict: errors.length === 0
    ? "resplit_currency_api_eve_installed_local_only"
    : "resplit_currency_api_eve_install_incomplete",
  repo: root,
  gitStatus: status.split("\n"),
  dependencyVersions: Object.fromEntries(
    Object.keys(requiredDeps).map((name) => [
      name,
      packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name],
    ]),
  ),
  dependencyLocation: "package.json",
  scripts: requiredScripts,
  filesChecked: requiredFiles.length,
  gatesNotCrossed: [
    "no Cloudflare deploy",
    "no GCP deploy",
    "no Terraform state mutation",
    "no GitHub Actions dispatch",
    "no Eve hosted link/deploy",
    "no model/API call",
    "no credentials or secrets",
    "no production snapshot publication",
    "no remote-machine mutation",
  ],
  errors,
  warnings,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Resplit Currency API Eve capability check: ${report.ok ? "PASS" : "FAIL"}`);
  console.log(`Verdict: ${report.verdict}`);
  console.log(`Files checked: ${report.filesChecked}`);
  console.log(`Scripts: ${report.scripts.join(", ")}`);
  if (report.warnings.length) console.log(`Warnings:\n- ${report.warnings.join("\n- ")}`);
  if (report.errors.length) console.error(`Errors:\n- ${report.errors.join("\n- ")}`);
}

process.exitCode = report.ok ? 0 : 1;
