const FLATCAR_CHANNEL = "stable";
const FLATCAR_ARCH = "amd64";

function flatcarImageUrl(provider) {
  return `https://${FLATCAR_CHANNEL}.release.flatcar-linux.net/${FLATCAR_ARCH}-usr/current/flatcar_production_${provider}_image.bin.bz2`;
}

const providers = {
  vultr: {
    imageText: "Flatcar is available as a Vultr server image.",
    links: [
      ["Open Vultr deploy", "https://my.vultr.com/deploy/"],
      ["Flatcar on Vultr", "https://docs.vultr.com/ignition"],
    ],
    steps: [
      "Create a new server and choose Flatcar Container Linux.",
      "Paste the copied Ignition JSON into the Ignition or user-data field.",
    ],
  },
  digitalocean: {
    imageText: flatcarImageUrl("digitalocean"),
    links: [
      ["Open custom images", "https://cloud.digitalocean.com/images/custom_images"],
      ["Create Droplet", "https://cloud.digitalocean.com/droplets/new"],
    ],
    steps: [
      "Import the Flatcar image URL as a custom image.",
      "Create a Droplet from that image and enable User Data.",
      "Paste the copied Ignition JSON into the User Data field.",
    ],
  },
  hetzner: {
    imageText: flatcarImageUrl("hetzner"),
    links: [
      ["Open Hetzner Cloud", "https://console.hetzner.cloud/"],
      ["Flatcar on Hetzner", "https://www.flatcar.org/docs/latest/installing/cloud/hetzner/"],
    ],
    steps: [
      "Create a Flatcar snapshot from the image URL. Hetzner currently needs hcloud-upload-image and an API token for this step.",
      "Create a server from the Flatcar snapshot.",
      "Paste the copied Ignition JSON into the User Data field.",
    ],
  },
};

const form = document.querySelector("#config-form");
const layout = document.querySelector(".layout");
const authKey = document.querySelector("#auth-key");
const authKeyError = document.querySelector("#auth-key-error");
const hostname = document.querySelector("#hostname");
const exitNode = document.querySelector("#feature-exit-node");
const subnetRouter = document.querySelector("#feature-subnet-router");
const subnetRoutes = document.querySelector("#subnet-routes");
const subnetError = document.querySelector("#subnet-error");
const subnetField = document.querySelector("#subnet-field");
const tailnetEmail = document.querySelector("#tailnet-email");
const readiness = document.querySelector("#readiness");
const ignitionSize = document.querySelector("#ignition-size");
const imageUrl = document.querySelector("#image-url");
const providerSteps = document.querySelector("#provider-steps");
const providerLinks = document.querySelector("#provider-links");
const ignitionPreview = document.querySelector("#ignition-preview");
const ignitionPreviewPanel = document.querySelector("#ignition-preview-panel");
const policyPreview = document.querySelector("#policy-preview");
const downloadButton = document.querySelector("#download-ignition");
const copyIgnitionButton = document.querySelector("#copy-ignition");
const copyImageButton = document.querySelector("#copy-image-url");
const copyPolicyButton = document.querySelector("#copy-policy");
const toggleIgnitionPreviewButton = document.querySelector("#toggle-ignition-preview");
const themeToggleButton = document.querySelector("#theme-toggle");

const AUTH_KEY_PATTERN = /^tskey-auth-[A-Za-z0-9]{12}CNTRL-[A-Za-z0-9]{32,33}$/;
const REDACTED_AUTH_KEY = "tskey-auth-REDACTED";
const THEME_STORAGE_KEY = "easy-tailscale-server-theme";
let currentIgnition = "";
let currentPolicy = "";
let currentImageUrl = "";

function storedTheme() {
  try {
    const theme = localStorage.getItem(THEME_STORAGE_KEY);
    return theme === "light" || theme === "dark" ? theme : "";
  } catch {
    return "";
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is optional.
  }
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const targetTheme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${targetTheme} mode`;
  themeToggleButton.setAttribute("aria-label", label);
  themeToggleButton.title = label;
}

function selectedProvider() {
  return new FormData(form).get("provider") || "vultr";
}

function normalizeHostname(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function dataUrl(text) {
  return `data:,${encodeURIComponent(text)}`;
}

function splitRoutes(value) {
  return value
    .split(/[,\n]+/)
    .map((route) => route.trim())
    .filter(Boolean);
}

function isValidIpv4(address) {
  const parts = address.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isValidIpv6(address) {
  return address.includes(":") && /^[0-9a-f:]+$/i.test(address);
}

function isValidCidr(route) {
  const parts = route.split("/");
  if (parts.length !== 2) return false;

  const [address, prefixText] = parts;
  if (!/^\d{1,3}$/.test(prefixText)) return false;

  const prefix = Number(prefixText);
  if (isValidIpv4(address)) return prefix >= 0 && prefix <= 32;
  if (isValidIpv6(address)) return prefix >= 0 && prefix <= 128;
  return false;
}

function invalidRoutes(routes) {
  return routes.filter((route) => !isValidCidr(route));
}

function tailscaleEnv(config) {
  const extraArgs = [];

  if (config.exitNode) {
    extraArgs.push("--advertise-exit-node");
  }

  if (config.subnetRouter && config.subnetRoutes.length) {
    extraArgs.push(`--advertise-routes=${config.subnetRoutes.join(",")}`);
  }

  return [
    `TS_AUTHKEY=${config.authKey}`,
    "TS_AUTH_ONCE=true",
    `TS_HOSTNAME=${config.hostname}`,
    "TS_STATE_DIR=/var/lib/tailscale",
    "TS_USERSPACE=false",
    `TS_EXTRA_ARGS=${extraArgs.join(" ")}`,
    "TS_TAILSCALED_EXTRA_ARGS=--port=41641 --no-logs-no-support",
    "",
  ].join("\n");
}

function tailscaleUnit() {
  return `[Unit]
Description=Tailscale Docker Container
After=docker.service
Requires=docker.service

[Service]
TimeoutStartSec=0
ExecStartPre=-/usr/bin/docker rm --force tailscale
ExecStart=/usr/bin/docker run \\
  --name tailscale \\
  --pull=always \\
  --network host \\
  --env-file=/etc/tailscale/tailscale.env \\
  --log-driver=journald \\
  -v tailscale:/var/lib/tailscale \\
  --device=/dev/net/tun:/dev/net/tun \\
  --cap-add=NET_ADMIN \\
  --cap-add=NET_RAW \\
  ghcr.io/tailscale/tailscale:latest
ExecStop=/usr/bin/docker stop tailscale
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function buildIgnition(config) {
  const ignition = {
    ignition: {
      version: "3.3.0",
    },
    storage: {
      directories: [
        {
          path: "/etc/tailscale",
          mode: 448,
        },
      ],
      files: [
        {
          path: "/etc/tailscale/tailscale.env",
          contents: {
            compression: "",
            source: dataUrl(tailscaleEnv(config)),
          },
          mode: 384,
        },
        {
          path: "/etc/sysctl.d/99-tailscale.conf",
          contents: {
            compression: "",
            source: dataUrl(
              [
                "net.ipv4.ip_forward = 1",
                "net.ipv6.conf.all.forwarding = 1",
                "net.ipv6.conf.default.forwarding = 1",
                "",
              ].join("\n"),
            ),
          },
          mode: 420,
        },
        {
          path: "/etc/modules-load.d/tailscale.conf",
          contents: {
            compression: "",
            source: dataUrl(["ip6table_filter", "ip6table_nat", ""].join("\n")),
          },
          mode: 420,
        },
        {
          overwrite: true,
          path: "/etc/flatcar/update.conf",
          contents: {
            compression: "",
            source: dataUrl(
              [
                "REBOOT_STRATEGY=reboot",
                "LOCKSMITHD_REBOOT_WINDOW_START=02:00",
                "LOCKSMITHD_REBOOT_WINDOW_LENGTH=1h",
                "",
              ].join("\n"),
            ),
          },
          mode: 420,
        },
      ],
      links: [
        {
          overwrite: true,
          path: "/etc/localtime",
          target: "/usr/share/zoneinfo/Etc/UTC",
        },
      ],
    },
    systemd: {
      units: [
        {
          name: "tailscale.service",
          enabled: true,
          contents: tailscaleUnit(),
        },
      ],
    },
  };

  return ignition;
}

function buildPolicy(config) {
  const principal = config.tailnetEmail || "you@example.com";
  const policy = {};
  const autoApprovers = {};

  if (config.exitNode) {
    autoApprovers.exitNode = [principal];
  }

  if (config.subnetRouter && config.subnetRoutes.length) {
    autoApprovers.routes = Object.fromEntries(
      config.subnetRoutes.map((route) => [route, [principal]]),
    );
  }

  if (Object.keys(autoApprovers).length) {
    policy.autoApprovers = autoApprovers;
  }

  return JSON.stringify(policy, null, 2);
}

function readConfig() {
  const routes = splitRoutes(subnetRoutes.value);
  const authKeyValue = authKey.value.trim();

  return {
    provider: selectedProvider(),
    authKey: authKeyValue,
    authKeyValid: !authKeyValue || AUTH_KEY_PATTERN.test(authKeyValue),
    hostname: normalizeHostname(hostname.value) || "tailnet-server",
    exitNode: exitNode.checked,
    subnetRouter: subnetRouter.checked,
    subnetRoutes: routes,
    invalidSubnetRoutes: invalidRoutes(routes),
    tailnetEmail: tailnetEmail?.value.trim() || "",
  };
}

function redactIgnition(ignition, config) {
  const clone = structuredClone(ignition);
  if (config.authKey) {
    const envFile = clone.storage.files.find(
      (file) => file.path === "/etc/tailscale/tailscale.env",
    );
    envFile.contents.source = dataUrl(
      tailscaleEnv({
        ...config,
        authKey: REDACTED_AUTH_KEY,
      }),
    );
  }
  return JSON.stringify(clone, null, 2);
}

function escapeHtml(value) {
  const replacements = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  return value.replace(/[&<>"']/g, (char) => replacements[char]);
}

function highlightJson(json) {
  const tokenPattern =
    /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let highlighted = "";
  let lastIndex = 0;

  json.replace(tokenPattern, (token, _stringMatch, _keySuffix, offset) => {
    highlighted += escapeHtml(json.slice(lastIndex, offset));

    let className = "syntax-number";
    if (token.startsWith('"')) {
      className = token.trimEnd().endsWith(":") ? "syntax-key" : "syntax-string";
    } else if (token === "true" || token === "false") {
      className = "syntax-boolean";
    } else if (token === "null") {
      className = "syntax-null";
    }

    highlighted += `<span class="${className}">${escapeHtml(token)}</span>`;
    lastIndex = offset + token.length;
    return token;
  });

  highlighted += escapeHtml(json.slice(lastIndex));
  return highlighted;
}

function updateProvider(config) {
  const provider = providers[config.provider];
  currentImageUrl = provider.imageText.startsWith("http") ? provider.imageText : "";
  imageUrl.textContent = provider.imageText;
  copyImageButton.disabled = !currentImageUrl;

  providerSteps.innerHTML = "";
  const stepsFragment = document.createDocumentFragment();
  const appendStep = (step) => {
    const item = document.createElement("li");
    item.textContent = step;
    stepsFragment.append(item);
  };

  provider.steps.forEach(appendStep);
  appendStep("Use a cloud firewall that allows UDP 41641 inbound and outbound traffic.");
  appendStep("Wait for the device to appear in Tailscale.");

  if (config.exitNode) {
    appendStep("Approve it as an exit node, then select it on clients when needed.");
  }

  if (config.subnetRouter && config.subnetRoutes.length) {
    const routeLabel = config.subnetRoutes.length > 1 ? "routes" : "route";
    appendStep(`Approve the advertised subnet ${routeLabel}: ${config.subnetRoutes.join(", ")}.`);
  }
  providerSteps.append(stepsFragment);

  providerLinks.innerHTML = "";
  const linksFragment = document.createDocumentFragment();
  provider.links.forEach(([label, href]) => {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.textContent = label;
    linksFragment.append(anchor);
  });
  providerLinks.append(linksFragment);
}

function readinessState(config) {
  const hasFeature = config.exitNode || config.subnetRouter;
  const needsSubnet = config.subnetRouter && config.subnetRoutes.length === 0;
  const hasBadSubnet = config.subnetRouter && config.invalidSubnetRoutes.length > 0;

  if (!config.authKey) return { ready: false, label: "Tailscale key required" };
  if (!config.authKeyValid) return { ready: false, label: "Check auth key" };
  if (!hasFeature) return { ready: false, label: "Choose a feature" };
  if (needsSubnet) return { ready: false, label: "Subnet required" };
  if (hasBadSubnet) return { ready: false, label: "Check subnet" };
  if (!config.hostname) return { ready: false, label: "Check inputs" };
  return { ready: true, label: "Ready to copy" };
}

function setReadiness(config) {
  const state = readinessState(config);

  layout.classList.toggle("is-ready", state.ready);
  readiness.textContent = state.label;
  readiness.classList.toggle("ready", state.ready);
  readiness.classList.toggle("warn", !state.ready);
  downloadButton.disabled = !state.ready;
  copyIgnitionButton.disabled = !state.ready;
}

function updateConditionalFields(config) {
  const showAuthError = Boolean(config.authKey) && !config.authKeyValid;

  authKey.classList.toggle("has-error", showAuthError);
  if (config.authKeyValid) {
    authKey.removeAttribute("aria-invalid");
  } else {
    authKey.setAttribute("aria-invalid", "true");
  }
  authKeyError.classList.toggle("is-visible", showAuthError);
  authKeyError.setAttribute("aria-hidden", String(!showAuthError));
  subnetField.classList.toggle("is-hidden", !config.subnetRouter);
  subnetField.classList.toggle(
    "has-error",
    config.subnetRouter && config.invalidSubnetRoutes.length > 0,
  );
  subnetError.classList.toggle(
    "is-visible",
    config.subnetRouter && config.invalidSubnetRoutes.length > 0,
  );
  subnetError.setAttribute(
    "aria-hidden",
    String(!config.subnetRouter || config.invalidSubnetRoutes.length === 0),
  );
  if (config.subnetRouter && config.invalidSubnetRoutes.length > 0) {
    subnetRoutes.setAttribute("aria-invalid", "true");
  } else {
    subnetRoutes.removeAttribute("aria-invalid");
  }
}

function render() {
  const config = readConfig();
  updateConditionalFields(config);
  const ignition = buildIgnition(config);
  currentIgnition = JSON.stringify(ignition, null, 2);
  currentPolicy = buildPolicy(config);

  ignitionPreview.innerHTML = highlightJson(redactIgnition(ignition, config));
  policyPreview.textContent = currentPolicy;
  ignitionSize.textContent = `${Math.max(1, Math.round(currentIgnition.length / 1024))} KB`;

  updateProvider(config);
  setReadiness(config);
}

async function copyText(text, button) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.append(scratch);
    scratch.select();
    document.execCommand("copy");
    scratch.remove();
  }

  const original = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function downloadIgnition() {
  const config = readConfig();
  if (!readinessState(config).ready) return;

  const blob = new Blob([currentIgnition], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${config.hostname}-${config.provider}.ign`;
  document.body.append(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function setIgnitionPreviewExpanded(expanded) {
  ignitionPreviewPanel.classList.toggle("is-expanded", expanded);
  toggleIgnitionPreviewButton.setAttribute("aria-expanded", String(expanded));
  toggleIgnitionPreviewButton.textContent = expanded ? "Collapse" : "Expand";
}

setTheme(storedTheme() || "dark");

layout.addEventListener("input", render);
layout.addEventListener("change", render);
downloadButton.addEventListener("click", downloadIgnition);
copyIgnitionButton.addEventListener("click", () => copyText(currentIgnition, copyIgnitionButton));
copyImageButton.addEventListener("click", () => copyText(currentImageUrl, copyImageButton));
copyPolicyButton.addEventListener("click", () => copyText(currentPolicy, copyPolicyButton));
toggleIgnitionPreviewButton.addEventListener("click", () => {
  setIgnitionPreviewExpanded(!ignitionPreviewPanel.classList.contains("is-expanded"));
});
themeToggleButton.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  setTheme(nextTheme);
  saveTheme(nextTheme);
});

hostname.addEventListener("blur", () => {
  hostname.value = normalizeHostname(hostname.value) || "tailnet-server";
  render();
});

subnetRoutes.addEventListener("blur", () => {
  subnetRoutes.value = splitRoutes(subnetRoutes.value).join(", ");
  render();
});

render();
