# Security

## Reporting

Please report security problems privately through GitHub's
[security advisories](https://github.com/betaversionio/tubeship/security/advisories/new),
not in public issues.

## Credentials

tubeship stores an OAuth client (`client_secret.json`) and a refresh token
(`token.json`) in `~/.config/tubeship/<profile>/`, readable only by your user.
The refresh token can manage your channel: keep it private, never commit it,
and revoke it at <https://myaccount.google.com/permissions> if it leaks.
tubeship talks only to Google's OAuth and YouTube Data API endpoints.
