import { sanitizeEmailHtml, textToBasicEmailHtml } from './htmlSanitizer.ts';
import { stripHtmlTags } from './emailValidation.ts';
import { splitFullName } from './leadValidation.ts';

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_.\-\s]+?)\s*\}\}/g;

export function normalizePlaceholderKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function extractPlaceholders(template: string): string[] {
  if (!template) return [];
  const keys = new Set<string>();
  const regex = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    const normalized = normalizePlaceholderKey(match[1]);
    if (normalized) {
      keys.add(normalized);
    }
  }
  return Array.from(keys);
}

export function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface PlaceholderRecipientInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  company?: string;
  role?: string;
  website?: string;
  location?: string;
  industry?: string;
  customFields?: Map<string, string> | Record<string, string>;
}

export function buildRecipientContext(
  recipient: PlaceholderRecipientInput
): Record<string, string> {
  const fullName = (recipient.fullName || '').trim();
  const split = splitFullName(fullName);
  const firstName = (recipient.firstName || '').trim() || split.firstName;
  const lastName = (recipient.lastName || '').trim() || split.lastName;
  const resolvedFullName =
    fullName || [firstName, lastName].filter(Boolean).join(' ').trim();

  const ctx: Record<string, string> = {};

  if (recipient.customFields instanceof Map) {
    for (const [k, v] of recipient.customFields.entries()) {
      const norm = normalizePlaceholderKey(String(k));
      if (norm) ctx[norm] = String(v ?? '').trim();
    }
  } else if (recipient.customFields && typeof recipient.customFields === 'object') {
    for (const [k, v] of Object.entries(recipient.customFields)) {
      const norm = normalizePlaceholderKey(k);
      if (norm) ctx[norm] = String(v ?? '').trim();
    }
  }

  const assignIfPresent = (aliases: string[], value: string) => {
    const trimmed = value.trim();
    for (const alias of aliases) {
      if (trimmed || !(alias in ctx)) {
        ctx[alias] = trimmed;
      }
    }
  };

  assignIfPresent(['email'], recipient.email || '');
  assignIfPresent(['first_name', 'firstname'], firstName);
  assignIfPresent(['last_name', 'lastname'], lastName);
  assignIfPresent(['full_name', 'fullname', 'name'], resolvedFullName);
  assignIfPresent(['company', 'organization', 'org'], recipient.company || '');
  assignIfPresent(['role', 'title', 'job_title'], recipient.role || '');
  assignIfPresent(['website', 'url'], recipient.website || '');
  assignIfPresent(['location', 'city'], recipient.location || '');
  assignIfPresent(['industry'], recipient.industry || '');

  return ctx;
}

function renderSingleTemplate(
  template: string,
  context: Record<string, string>,
  options: { htmlEscape: boolean; missingCollector: Set<string> }
): string {
  if (!template) return '';
  return template.replace(PLACEHOLDER_REGEX, (_full, rawKey: string) => {
    const key = normalizePlaceholderKey(rawKey);
    const rawValue = key ? context[key] ?? '' : '';
    if (!rawValue) {
      if (key) options.missingCollector.add(key);
      return '';
    }
    return options.htmlEscape ? escapeHtmlValue(rawValue) : rawValue;
  });
}

export interface RenderCampaignMessageInput {
  subjectTemplate: string;
  bodyTextTemplate?: string;
  bodyHtmlTemplate?: string;
  customSubject?: string;
  customBodyText?: string;
  customBodyHtml?: string;
  recipient: PlaceholderRecipientInput;
}

export interface RenderedCampaignMessage {
  subject: string;
  text: string;
  html: string;
  missingPlaceholders: string[];
}

export function renderCampaignMessageForRecipient(
  input: RenderCampaignMessageInput
): RenderedCampaignMessage {
  const context = buildRecipientContext(input.recipient);
  const missing = new Set<string>();

  const effectiveSubjectTpl = (input.customSubject?.trim()
    ? input.customSubject
    : input.subjectTemplate
  ).trim();

  const effectiveTextTpl = input.customBodyText?.trim()
    ? input.customBodyText
    : input.bodyTextTemplate || '';

  const effectiveHtmlTpl = input.customBodyHtml?.trim()
    ? input.customBodyHtml
    : input.bodyHtmlTemplate || '';

  const renderedSubject = renderSingleTemplate(effectiveSubjectTpl, context, {
    htmlEscape: false,
    missingCollector: missing,
  })
    .replace(/[\r\n\0]+/g, ' ')
    .trim();

  let renderedHtml = '';
  if (effectiveHtmlTpl.trim()) {
    const rawRenderedHtml = renderSingleTemplate(effectiveHtmlTpl, context, {
      htmlEscape: true,
      missingCollector: missing,
    });
    renderedHtml = sanitizeEmailHtml(rawRenderedHtml);
  }

  let renderedText = '';
  if (effectiveTextTpl.trim()) {
    renderedText = renderSingleTemplate(effectiveTextTpl, context, {
      htmlEscape: false,
      missingCollector: missing,
    }).trim();
  }

  if (!renderedHtml && renderedText) {
    renderedHtml = textToBasicEmailHtml(renderedText);
  } else if (!renderedText && renderedHtml) {
    renderedText = stripHtmlTags(renderedHtml);
  }

  return {
    subject: renderedSubject,
    text: renderedText,
    html: renderedHtml,
    missingPlaceholders: Array.from(missing),
  };
}
