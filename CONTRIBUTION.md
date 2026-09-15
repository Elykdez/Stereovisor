# Contribution

## Versioning

The client and the service carry independent semver, both declared in
[`versions.json`](versions.json):

```powershell
npm run version:bump client minor
npm run version:set service 1.2.0
```

A bump rewrites the `version` field in `package.json` and regenerates
`service/src/_version.py`. `npm run check` fails if either output is stale, the
same way it fails on stale locales. Releases are tagged per component as
`client-vX.Y.Z` and `service-vX.Y.Z`.