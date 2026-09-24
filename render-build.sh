#!/usr/bin/env bash
set -euo pipefail

echo "[render-build] Limpiando caches incompletos de Puppeteer..."
rm -rf .cache/puppeteer || true
rm -rf /opt/render/.cache/puppeteer || true
rm -rf "${HOME:-/opt/render}/.cache/puppeteer" || true

echo "[render-build] Instalando dependencias con package-lock.json..."
npm ci --no-audit --no-fund

echo "[render-build] Build terminado."
