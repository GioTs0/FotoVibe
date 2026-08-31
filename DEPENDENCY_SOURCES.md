# Dependency sources

FotoVibe is deployed from a clean Cloud Build environment. Public dependencies
must therefore be resolved from their public registries:

- Python: `https://pypi.org/simple` (with artifacts from `files.pythonhosted.org`)
- JavaScript: `https://registry.npmjs.org` (if JavaScript packages are added)

The Sportradar dependency proxy (`cdproxy.sportradar.online`) is a local
developer convenience only. It must never be written into a committed lockfile,
package manifest, `.npmrc`, Docker build input, or CI configuration. A lockfile
generated while the proxy is configured can make Cloud Build unable to fetch a
package.

Before committing dependency changes, verify the build inputs:

```sh
for file in uv.lock package-lock.json .npmrc pyproject.toml package.json Dockerfile .gitlab-ci.yml; do
  [ -f "$file" ] && rg -n -i 'cdproxy\.sportradar\.online' "$file"
done
```

The command must produce no output. `scripts/deploy.py` performs the same check
before it provisions or deploys Cloud Run. If an older local `uv` invocation has
already written the known Python proxy URLs into `uv.lock`, the deploy script
repairs those URLs first; proxy references in any other build input still stop
the deployment.
