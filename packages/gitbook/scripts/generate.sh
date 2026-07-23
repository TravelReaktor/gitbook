#!/bin/bash

set -o errexit
set -o pipefail

# Copy the assets
gitbook-icons ./public/~gitbook/static/icons brands,duotone,solid,regular,light,thin,custom-icons
gitbook-math ./public/~gitbook/static/math
cp -r ../embed/standalone/ ./public/~gitbook/static/embed

# Generate the types
wrangler types
