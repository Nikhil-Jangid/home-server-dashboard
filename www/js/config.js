// Fixed client settings. Everything about the machine (host name, CPU, Quick Launch tiles, hidden
// containers, quiet journal patterns) comes from the server: /api/settings, read from ~/.config/home-server-dashboard/.
export const CONFIG = {
  pollSeconds: 3,
  apiPath: '/api/4/all',
  settingsPath: '/api/settings',
  portsPath: '/api/ports',
  settingsSeconds: 30
};
