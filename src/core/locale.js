import { messages } from './messages.js';

export const isIndonesian = language => ['id-ID', 'Bahasa Indonesia'].includes(language);
const indonesian = new Map(messages);
const english = new Map(messages.map(([en, id]) => [id, en]));

// Apply this only to interface messages, never to names, descriptions, or comments.
// The reverse lookup also handles system notifications written by older releases.
export function translate(message, language = 'en-US') {
  const source = english.get(message) || message;
  return isIndonesian(language) ? indonesian.get(source) || source : source;
}
