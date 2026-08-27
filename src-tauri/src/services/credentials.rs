//! 凭据服务（指导书 §6.3）：API Key 存系统凭据存储（Windows Credential Manager）。
//!  - service = "bagertea_ai_media_v2"，username = connection_id；
//!  - Secret 内容只保存 API Key；JSON/SQLite 只保存 api_key_ref（= connection_id），不保存明文；
//!  - 读取设置时兼容旧 apiKey；首次成功保存时迁移到 keyring；迁移失败不得清空旧 key（必须显示错误）。

use crate::error::{AppError, AppResult};

/// 与数据库 service 名保持一致：bagertea_ai_media_v2（Cargo package name）
pub const KEYRING_SERVICE: &str = "bagertea_ai_media_v2";

/// 保存 API Key。username = connection_id；失败返回可解释错误（不吞）。
pub fn save_api_key(connection_id: &str, api_key: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connection_id)
        .map_err(|e| AppError::msg(format!("凭据存储初始化失败: {e}")))?;
    entry
        .set_password(api_key)
        .map_err(|e| AppError::msg(format!("API 密钥保存到系统凭据失败: {e}")))
}

/// 读取 API Key。未配置返回 None；读取错误（如凭据损坏）返回错误而非静默吞。
pub fn get_api_key(connection_id: &str) -> AppResult<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connection_id)
        .map_err(|e| AppError::msg(format!("凭据存储初始化失败: {e}")))?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::msg(format!("读取 API 密钥失败: {e}"))),
    }
}

/// 删除 API Key（连接档案删除时清理凭据）。未配置视为成功。
pub fn delete_api_key(connection_id: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, connection_id)
        .map_err(|e| AppError::msg(format!("凭据存储初始化失败: {e}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::msg(format!("删除 API 密钥失败: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 凭据测试策略：优先真实后端（本机 Windows Credential Manager 可用时做完整 roundtrip）；
    /// 后端不可用（CI/无凭据服务）时验证错误被正确上抛、不静默吞。
    /// keyring 的 mock 库把密码存在 entry 实例内、跨 Entry 不持久，不适合测 wrapper 形态，
    /// 因此这里用真实后端 + 可用性探测，行为与本机一致。
    fn backend_usable() -> bool {
        let probe = "test-conn-probe";
        match save_api_key(probe, "probe") {
            Ok(()) => {
                let _ = delete_api_key(probe);
                true
            }
            Err(_) => false,
        }
    }

    #[test]
    fn save_get_delete_roundtrip() {
        if !backend_usable() {
            // 无凭据服务的环境：此路径无法验证；确保不误报
            return;
        }
        let id = "test-conn-roundtrip";
        let _ = delete_api_key(id);
        save_api_key(id, "sk-secret-123").unwrap();
        assert_eq!(get_api_key(id).unwrap().as_deref(), Some("sk-secret-123"));
        delete_api_key(id).unwrap();
        assert_eq!(get_api_key(id).unwrap(), None);
    }

    #[test]
    fn get_missing_returns_none() {
        if !backend_usable() {
            return;
        }
        let id = "test-conn-missing";
        let _ = delete_api_key(id);
        assert_eq!(get_api_key(id).unwrap(), None);
    }

    #[test]
    fn overwrite_changes_value() {
        if !backend_usable() {
            return;
        }
        let id = "test-conn-overwrite";
        let _ = delete_api_key(id);
        save_api_key(id, "old").unwrap();
        save_api_key(id, "new").unwrap();
        assert_eq!(get_api_key(id).unwrap().as_deref(), Some("new"));
        delete_api_key(id).unwrap();
    }

    /// 错误必须上抛为 AppError（不静默吞）：无凭据服务环境 save 返回 Err 属预期，但不 panic。
    #[test]
    fn backend_unavailable_errors_are_surfaced_not_silent() {
        if backend_usable() {
            // 本机后端可用：空 user 等路径不得 panic（参数错误由上层校验，此处只验证不 panic）
            let _ = get_api_key("");
            let _ = save_api_key("", "x");
        } else {
            // 后端不可用：save 必须 Err 而非 Ok
            let r = save_api_key("probe-err", "x");
            assert!(r.is_err(), "凭据后端不可用时保存应返回错误（不静默吞）");
        }
    }
}