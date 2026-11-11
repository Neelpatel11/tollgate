import type { ChatMessage, ChatRequest, ContentPart } from './types.js';

export interface RedactionOptions {
  emails: boolean;
  phones: boolean;
  cards: boolean;
  govIds: boolean;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const CARD = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
const IN_MOBILE = /(?<![\w])(?:\+91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)/g;
const INTL_PHONE = /(?<![\w])\+\d{1,3}[\s-]?\(?\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/g;
const AADHAAR = /(?<!\d[\s-]?)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?![\s-]?\d)/g;
const PAN = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactText(text: string, opts: RedactionOptions): { text: string; count: number } {
  let count = 0;
  const swap = (re: RegExp, label: string, guard?: (m: string) => boolean) => {
    text = text.replace(re, (m) => {
      if (guard && !guard(m)) return m;
      count++;
      return `[${label}]`;
    });
  };
  if (opts.emails) swap(EMAIL, 'EMAIL');
  if (opts.cards) swap(CARD, 'CARD', (m) => luhn(m.replace(/\D/g, '')));
  if (opts.govIds) {
    swap(PAN, 'PAN');
    swap(SSN, 'SSN');
    swap(AADHAAR, 'AADHAAR', (m) => m.replace(/\D/g, '').length === 12);
  }
  if (opts.phones) {
    swap(IN_MOBILE, 'PHONE');
    swap(INTL_PHONE, 'PHONE');
  }
  return { text, count };
}

export function redactRequest(req: ChatRequest, opts: RedactionOptions): { request: ChatRequest; count: number } {
  let count = 0;
  const messages = req.messages.map((m): ChatMessage => {
    if (typeof m.content === 'string') {
      const r = redactText(m.content, opts);
      count += r.count;
      return { ...m, content: r.text };
    }
    if (Array.isArray(m.content)) {
      const parts = m.content.map((p): ContentPart => {
        if (p.type !== 'text') return p;
        const r = redactText(p.text, opts);
        count += r.count;
        return { ...p, text: r.text };
      });
      return { ...m, content: parts };
    }
    return m;
  });
  return { request: { ...req, messages }, count };
}
