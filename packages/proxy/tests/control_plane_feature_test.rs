//! What the `control-plane` feature puts in the proxy binary.
//!
//! A plain `cargo build` is the open-core proxy: standalone, with no code that
//! calls an Intutic control plane. The routes the clients call are string
//! literals in the code that calls them, so their absence from the binary is
//! the observable proof the clients are not compiled in. A client ungated by
//! accident puts its route back and fails here.

const PROXY: &str = env!("CARGO_BIN_EXE_intutic-proxy");

/// Every route the control-plane clients call.
const CONTROL_PLANE_ROUTES: &[&str] = &[
    "/api/v1/auth/key-context",
    "/api/v1/policy/check",
    "/api/v1/policy/resolve",
    "/api/v1/judge/chunk",
    "/api/v1/judge/finalize",
    "/api/v1/fix/enhance",
    "/api/v1/workspace/sops-policy",
    "/api/v1/decide/events",
    "/api/v1/decisions",
    "/api/v1/slash-command",
    "/api/v1/sessions/",
    "/api/v1/gateways/",
];

/// The binary as text, for a substring search: non-UTF-8 bytes become U+FFFD
/// and the routes are ASCII.
fn binary_text() -> String {
    let binary = std::fs::read(PROXY).expect("the proxy binary is built for this test");
    String::from_utf8_lossy(&binary).into_owned()
}

#[cfg(not(feature = "control-plane"))]
#[test]
fn the_open_core_binary_has_no_control_plane_client_in_it() {
    let binary = binary_text();
    let present: Vec<&str> = CONTROL_PLANE_ROUTES
        .iter()
        .copied()
        .filter(|route| binary.contains(route))
        .collect();
    assert!(
        present.is_empty(),
        "control-plane routes compiled into the default build: {present:?}"
    );
}

#[cfg(feature = "control-plane")]
#[test]
fn the_control_plane_binary_has_every_client_in_it() {
    let binary = binary_text();
    let missing: Vec<&str> = CONTROL_PLANE_ROUTES
        .iter()
        .copied()
        .filter(|route| !binary.contains(route))
        .collect();
    assert!(
        missing.is_empty(),
        "control-plane routes missing from the feature build: {missing:?}"
    );
}

/// Running on regardless would serve a deployment its operator believes is
/// authenticated and budgeted with neither.
#[cfg(not(feature = "control-plane"))]
#[test]
fn a_build_without_the_clients_refuses_to_start_when_a_control_plane_is_configured() {
    let home = std::env::temp_dir().join(format!("intutic-cp-feature-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let out = std::process::Command::new(PROXY)
        .env("CONTROL_PLANE_URL", "http://127.0.0.1:9")
        .env("HOME", &home)
        .env("CONFIG_PATH", home.join("none.yaml"))
        .env("PORT", "0")
        .current_dir(&home)
        .output()
        .expect("the proxy binary runs");
    let _ = std::fs::remove_dir_all(&home);
    assert!(!out.status.success(), "started with a control plane set");
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.contains("`control-plane` feature"),
        "the refusal says why: {stderr}"
    );
}
