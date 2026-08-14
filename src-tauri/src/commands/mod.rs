//! commands 层：只做参数校验与转发，业务在 services / db（共享知识 #2）

pub mod ai_cmd;
pub mod assets_cmd;
pub mod export_cmd;
pub mod import_cmd;
pub mod settings_cmd;
pub mod tags_cmd;
pub mod thumbnail_cmd;

pub use ai_cmd::*;
pub use assets_cmd::*;
pub use export_cmd::*;
pub use import_cmd::*;
pub use settings_cmd::*;
pub use tags_cmd::*;
pub use thumbnail_cmd::*;
