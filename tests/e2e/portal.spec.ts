import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test, expect } from "@playwright/test";

const adminUsername = process.env.E2E_ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? "";
const repoRoot = process.env.E2E_REPO_ROOT ?? "/data/vps-mcp/smoke";
if (!adminPassword) throw new Error("E2E_ADMIN_PASSWORD is required");

let repoParent = "";
let repo = "";
const workspaceName = `UI E2E ${Date.now()}`;
const chatTitle = `Portal happy path ${Date.now()}`;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

test.beforeAll(async () => {
  await mkdir(repoRoot, { recursive: true });
  repoParent = await mkdtemp(join(repoRoot, "ui-e2e-"));
  repo = join(repoParent, "repo");
  execFileSync("mkdir", ["-p", repo]);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "ui-e2e@example.com");
  git(repo, "config", "user.name", "UI E2E");
  await writeFile(join(repo, "README.md"), "browser e2e\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "base");
});

test.afterAll(async () => {
  if (repoParent) await rm(repoParent, { recursive: true, force: true });
});

test("Codex-style portal happy path", async ({ page, context }) => {
  const pageErrors: string[] = [];
  const unexpectedHttp: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("response", (response) => {
    const status = response.status();
    const pathname = new URL(response.url()).pathname;
    if (status >= 400 && !(status === 401 && pathname === "/api/me")) unexpectedHttp.push(`${status} ${pathname}`);
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "VPS Agent" })).toBeVisible();
  await page.getByLabel("Username").fill(adminUsername);
  await page.getByLabel("Password").fill(adminPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();

  await page.locator(".workspace-select > button").click();
  const newWorkspace = page.getByRole("button", { name: /New workspace/i });
  if (await newWorkspace.isVisible().catch(() => false)) await newWorkspace.click();
  await page.getByLabel("Name").fill(workspaceName);
  await page.getByRole("button", { name: "Browse VPS" }).click();
  await expect(page.getByRole("heading", { name: "Select workspace folder" })).toBeVisible();
  await page.locator(".repo-list > button").filter({ hasText: "/data" }).click();
  for (const folder of ["vps-mcp", "smoke", basename(repoParent)]) {
    await page.locator(".repo-open").filter({ hasText: folder }).click();
  }
  await page.getByLabel("New folder name").fill("portal-workspace");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect(page.locator(".repo-picker-head b")).toContainText("portal-workspace");
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.getByLabel("Workspace folder")).toHaveValue(join(repoParent, "portal-workspace"));
  await page.getByLabel("Project instructions").fill("Keep tests green. This is a browser E2E workspace.");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.locator(".workspace-select")).toContainText(workspaceName);

  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByLabel("Task name").fill(chatTitle);
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("button", { name: "Create chat" }).click();
  await expect(page.locator(".chat-header h2")).toHaveText(chatTitle);
  await expect(page.locator(".mode-switch button.active")).toContainText("Plan");

  const composer = page.locator(".composer-row textarea");
  await composer.fill("Browser E2E message");
  await composer.press("Enter");
  await expect(page.locator(".message.user .message-body")).toContainText("Browser E2E message");

  const pixel = join(repoParent, "pixel.png");
  await writeFile(pixel, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLsAAAAASUVORK5CYII=", "base64"));
  await page.locator('input[type="file"]').setInputFiles(pixel);
  await expect(page.locator(".pending-files")).toContainText("pixel.png");
  await composer.fill("Screenshot attached");
  await composer.press("Enter");
  await expect(page.getByAltText("pixel.png")).toBeVisible();

  await page.getByRole("button", { name: /Connect/ }).click();
  await expect(page.getByRole("heading", { name: "Connect ChatGPT" })).toBeVisible();
  await expect(page.locator(".binding-code code")).toContainText("connect to bind_");
  await page.locator(".modal .icon-btn").click();

  await page.getByRole("button", { name: "Build", exact: true }).click();
  await expect(page.locator(".mode-switch button.active")).toContainText("Build");
  await expect(page.locator(".composer-foot")).toContainText("Build mode");

  await page.setViewportSize({ width: 480, height: 820 });
  await expect(page.locator(".chat-header")).toBeVisible();
  await expect(page.locator(".composer-shell")).toBeVisible();

  // Cleanup through the authenticated browser context.
  const csrfCookie = (await context.cookies()).find((cookie) => cookie.name === "vpsmcp_csrf");
  expect(csrfCookie).toBeTruthy();
  const workspaces = await (await page.request.get("/api/workspaces")).json();
  const workspace = workspaces.find((item: any) => item.name === workspaceName);
  expect(workspace).toBeTruthy();
  const chats = await (await page.request.get(`/api/workspaces/${workspace.id}/chats`)).json();
  const chat = chats.find((item: any) => item.title === chatTitle);
  expect(chat).toBeTruthy();
  const headers = { "x-csrf-token": csrfCookie!.value };
  expect((await page.request.delete(`/api/chats/${chat.id}`, { headers })).status()).toBe(204);
  expect((await page.request.delete(`/api/workspaces/${workspace.id}`, { headers })).status()).toBe(204);

  expect(pageErrors, `browser page errors: ${pageErrors.join(" | ")}`).toEqual([]);
  expect(unexpectedHttp, `unexpected HTTP errors: ${unexpectedHttp.join(" | ")}`).toEqual([]);
});
