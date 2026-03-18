import { readFileSync } from "fs";
import { createSign } from "crypto";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { expandHomePath } from "./path-utils.js";

function getProxyDispatcher(): Dispatcher | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (proxyUrl) {
    return new ProxyAgent(proxyUrl);
  }
  return undefined;
}

function proxyFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const dispatcher = getProxyDispatcher();
  if (dispatcher) {
    return undiciFetch(url, {
      ...options,
      dispatcher,
    }) as unknown as Promise<Response>;
  }
  return fetch(url, options);
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function createJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };

  const segments = [
    base64url(Buffer.from(JSON.stringify(header))),
    base64url(Buffer.from(JSON.stringify(payload))),
  ];

  const sign = createSign("RSA-SHA256");
  sign.update(segments.join("."));
  const signature = base64url(sign.sign(privateKey));

  return segments.join(".") + "." + signature;
}

export async function getGitHubAppInstallationToken(
  appId: string,
  privateKeyPath: string,
): Promise<string> {
  const resolvedPath = expandHomePath(privateKeyPath);
  const privateKey = readFileSync(resolvedPath, "utf8");
  const jwt = createJWT(appId, privateKey);

  const installationsResponse = await proxyFetch(
    "https://api.github.com/app/installations",
    {
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!installationsResponse.ok) {
    throw new Error(
      `GitHub App: failed to get installations: ${installationsResponse.status} ${await installationsResponse.text()}`,
    );
  }

  const installations = (await installationsResponse.json()) as { id: number }[];
  if (installations.length === 0) {
    throw new Error(
      "GitHub App: no installations found. Install the GitHub App on your account/repos first.",
    );
  }

  const installationId = installations[0].id;

  const tokenResponse = await proxyFetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!tokenResponse.ok) {
    throw new Error(
      `GitHub App: failed to get installation token: ${tokenResponse.status} ${await tokenResponse.text()}`,
    );
  }

  const tokenData = (await tokenResponse.json()) as { token: string };
  return tokenData.token;
}
