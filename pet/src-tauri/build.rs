fn main() {
    println!("cargo:rerun-if-env-changed=DSHPET_YY_THUNKS_OBJ");
    println!("cargo:rerun-if-env-changed=DSHPET_VC_LTL_LIB");
    println!("cargo:rerun-if-env-changed=DSHPET_WIN7_OLE32_SHIM_OBJ");
    #[cfg(feature = "win7")]
    {
        if let Ok(vc_ltl) = std::env::var("DSHPET_VC_LTL_LIB") {
            let trimmed = vc_ltl.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-search=native={}", trimmed);
            }
        }
        if let Ok(shim) = std::env::var("DSHPET_WIN7_OLE32_SHIM_OBJ") {
            for part in shim.split(';') {
                let trimmed = part.trim();
                if !trimmed.is_empty() {
                    println!("cargo:rustc-link-arg-bin=DshPet={}", trimmed);
                }
            }
        }
        if let Ok(obj) = std::env::var("DSHPET_YY_THUNKS_OBJ") {
            let trimmed = obj.trim();
            if !trimmed.is_empty() {
                println!("cargo:rustc-link-arg-bin=DshPet={}", trimmed);
                println!("cargo:rustc-link-arg-bin=DshPet=/SUBSYSTEM:WINDOWS,6.01");
            }
        }
    }
    tauri_build::build()
}
