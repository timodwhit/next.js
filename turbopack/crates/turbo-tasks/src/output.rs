use std::{
    borrow::Cow,
    fmt::{self, Display},
};

use crate::{util::SharedError, RawVc};

/// A helper type representing the output of a resolved task.
#[derive(Clone, Debug)]
pub enum OutputContent {
    Link(RawVc),
    Error(SharedError),
    Panic(Option<Box<Cow<'static, str>>>),
}

impl Display for OutputContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OutputContent::Link(raw_vc) => write!(f, "link {:?}", raw_vc),
            OutputContent::Error(err) => write!(f, "error {}", err),
            OutputContent::Panic(Some(message)) => write!(f, "panic {}", message),
            OutputContent::Panic(None) => write!(f, "panic"),
        }
    }
}
