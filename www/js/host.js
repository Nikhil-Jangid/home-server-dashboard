// Header, footer and terminal labels from /api/settings. No DOM access.
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function hostLabels(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const h = s.host && typeof s.host === 'object' ? s.host : {};
  const name = str(h.name), user = str(h.user), version = str(s.version);
  return {
    hostName: name ?? '—',
    cpu: str(h.cpu) ?? '—',
    session: name && user ? user + '@' + name : '—',
    version: version ? 'v' + version : '',
    problems: Array.isArray(s.problems) ? s.problems.filter(p => typeof p === 'string').join(' · ') : ''
  };
}
