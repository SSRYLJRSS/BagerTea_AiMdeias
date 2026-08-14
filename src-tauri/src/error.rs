//! 统一错误模型：所有 command 返回 Result<T, AppError>，序列化为 { code, message }

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("图像错误: {0}")]
    Image(#[from] image::ImageError),
    #[error("{0}")]
    Msg(String),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        Self::Msg(s.into())
    }
    fn code(&self) -> &'static str {
        match self {
            Self::Db(_) => "DB",
            Self::Io(_) => "IO",
            Self::Json(_) => "JSON",
            Self::Image(_) => "IMAGE",
            Self::Msg(_) => "ERROR",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct ErrBody<'a> {
            code: &'a str,
            message: String,
        }
        ErrBody {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;
