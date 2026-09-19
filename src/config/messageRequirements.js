const fs = require('fs');
const path = require('path');

const CHANNEL_ID_PATTERN = /^\d{15,22}$/;
const RULE_TYPES = new Set(['mediaOnly', 'requiredLink']);

function parseSnowflakeList(value, variableName) {
  const rawValue = String(value ?? '').trim();
  if (!rawValue) return [];

  const ids = rawValue
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);

  const invalidIds = ids.filter((id) => !CHANNEL_ID_PATTERN.test(id));
  if (invalidIds.length > 0) {
    throw new Error(
      `Invalid Discord channel ID(s) in ${variableName}: ${invalidIds.join(', ')}.`
    );
  }

  return Array.from(new Set(ids));
}

function normalizeDomain(value, location) {
  const rawValue = String(value ?? '').trim().toLowerCase();
  if (!rawValue) {
    throw new Error(`Invalid domain "${value}" at ${location}.`);
  }

  const candidate = /^https?:\/\//.test(rawValue) ? rawValue : `https://${rawValue}`;

  try {
    const parsed = new URL(candidate);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('domain contains URL components other than the hostname');
    }

    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    throw new Error(`Invalid domain "${value}" at ${location}.`);
  }
}

function normalizePathPrefix(value, location) {
  const prefix = String(value ?? '').trim();
  if (!prefix.startsWith('/')) {
    throw new Error(`Path prefix "${value}" at ${location} must start with "/".`);
  }
  return prefix;
}

function normalizeQueryParams(value, location) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`queryParams at ${location} must be an object.`);
  }

  const normalized = {};

  for (const [name, requirement] of Object.entries(value)) {
    const parameterName = String(name).trim();
    if (!parameterName) {
      throw new Error(`queryParams at ${location} contains an empty parameter name.`);
    }

    if (requirement === true) {
      normalized[parameterName] = true;
      continue;
    }

    if (typeof requirement !== 'string' || requirement.length === 0) {
      throw new Error(
        `Query parameter "${parameterName}" at ${location} must be true or a regular-expression string.`
      );
    }

    try {
      new RegExp(requirement);
    } catch (error) {
      throw new Error(
        `Invalid regular expression for query parameter "${parameterName}" at ${location}: ${error.message}`
      );
    }

    normalized[parameterName] = requirement;
  }

  return normalized;
}

function normalizeRule(rule, location) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`Requirement at ${location} must be an object.`);
  }

  const type = String(rule.type ?? '').trim();
  if (!RULE_TYPES.has(type)) {
    throw new Error(
      `Unsupported requirement type "${type || '(missing)'}" at ${location}. Supported types: ${Array.from(
        RULE_TYPES
      ).join(', ')}.`
    );
  }

  if (type === 'mediaOnly') {
    return { type };
  }

  const domains = Array.isArray(rule.domains)
    ? rule.domains.map((domain, index) => normalizeDomain(domain, `${location}.domains[${index}]`))
    : [];

  if (domains.length === 0) {
    throw new Error(`requiredLink at ${location} must contain at least one domain.`);
  }

  const pathPrefixes = Array.isArray(rule.pathPrefixes)
    ? rule.pathPrefixes.map((prefix, index) =>
        normalizePathPrefix(prefix, `${location}.pathPrefixes[${index}]`)
      )
    : [];

  const minMatches = Number.isInteger(rule.minMatches) ? rule.minMatches : 1;
  if (minMatches < 1 || minMatches > 50) {
    throw new Error(`minMatches at ${location} must be an integer between 1 and 50.`);
  }

  return {
    type,
    domains: Array.from(new Set(domains)),
    pathPrefixes: Array.from(new Set(pathPrefixes)),
    queryParams: normalizeQueryParams(rule.queryParams, `${location}.queryParams`),
    minMatches,
    allowSubdomains: rule.allowSubdomains !== false,
    rejectOtherLinks: rule.rejectOtherLinks === true,
  };
}

function normalizeChannelPolicy(channelId, value) {
  if (!CHANNEL_ID_PATTERN.test(String(channelId))) {
    throw new Error(`Invalid Discord channel ID in message requirements: ${channelId}.`);
  }

  const source = Array.isArray(value) ? { requirements: value } : value;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Policy for channel ${channelId} must be an object or requirement array.`);
  }

  if (!Array.isArray(source.requirements) || source.requirements.length === 0) {
    throw new Error(`Policy for channel ${channelId} must contain a non-empty requirements array.`);
  }

  return {
    ignoreBots: source.ignoreBots !== false,
    requirements: source.requirements.map((rule, index) =>
      normalizeRule(rule, `channel ${channelId}.requirements[${index}]`)
    ),
  };
}

function normalizeMessageRequirements(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Message requirements configuration must be a JSON object keyed by channel ID.');
  }

  return Object.fromEntries(
    Object.entries(raw).map(([channelId, policy]) => [
      String(channelId),
      normalizeChannelPolicy(String(channelId), policy),
    ])
  );
}

function parseJson(raw, sourceName) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourceName}: ${error.message}`);
  }
}

function loadMessageRequirements({
  filePath,
  explicitFilePath = false,
  jsonValue,
  legacyMediaOnlyChannelIds = [],
}) {
  let merged = {};

  if (filePath && fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    merged = { ...merged, ...parseJson(raw, filePath) };
  } else if (explicitFilePath) {
    throw new Error(`MESSAGE_REQUIREMENTS_FILE does not exist: ${filePath}`);
  }

  if (String(jsonValue ?? '').trim()) {
    merged = {
      ...merged,
      ...parseJson(String(jsonValue), 'MESSAGE_REQUIREMENTS_JSON'),
    };
  }

  const normalized = normalizeMessageRequirements(merged);

  for (const channelId of legacyMediaOnlyChannelIds) {
    const policy = normalized[channelId] || { ignoreBots: true, requirements: [] };
    if (!policy.requirements.some((rule) => rule.type === 'mediaOnly')) {
      policy.requirements.push({ type: 'mediaOnly' });
    }
    normalized[channelId] = policy;
  }

  return normalized;
}

function resolveMessageRequirementsPath(processCwd, configuredPath) {
  const rawPath = String(configuredPath ?? '').trim();
  if (!rawPath) return path.join(processCwd, 'message-requirements.json');
  return path.isAbsolute(rawPath) ? rawPath : path.join(processCwd, rawPath);
}

module.exports = {
  loadMessageRequirements,
  normalizeMessageRequirements,
  parseSnowflakeList,
  resolveMessageRequirementsPath,
};
