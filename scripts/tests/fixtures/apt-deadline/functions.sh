# Only external SDK/package/browser readiness probes are fixture adapters.
playwright_pinned_version() { echo 1.0.0; }
install_os_utilities() { echo FIXTURE_UTILITIES; }
verify_required_os_packages() { test -f "$FIXTURE_DIR/installed"; }
ensure_playwright_browsers() { echo FIXTURE_BROWSER_EXECUTED; }
