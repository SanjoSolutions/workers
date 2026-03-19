# Contributing

## Testing

- `pnpm test` runs the automated unit and integration suite on all supported operating systems in CI.
- `pnpm test:smoke:packaged` installs the package tarball into a temporary project and smoke-tests the packaged `assistant` and `worker` entrypoints without Docker.
- `pnpm test:e2e` runs the Docker-based end-to-end flow.
