use std::sync::Mutex;
use typst::{
    Feature, Features, Library, LibraryExt, World,
    diag::{FileError, FileResult},
    foundations::{Bytes, Datetime, Duration},
    syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot},
    text::{Font, FontBook},
    utils::LazyHash,
};

pub struct MathWorld {
    main: FileId,
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    source: Mutex<Source>,
}

impl MathWorld {
    pub fn new() -> Self {
        let library = Library::builder()
            .with_features([Feature::Html].into_iter().collect::<Features>())
            .build();

        let main = FileId::new(RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("main.typ").unwrap(),
        ));
        let source = Source::new(main, "".into());

        Self {
            main,
            library: LazyHash::new(library),
            // HTML export emits semantic MathML rather than laying out glyphs, so
            // the browser is responsible for selecting and measuring math fonts.
            book: LazyHash::new(FontBook::new()),
            source: Mutex::new(source),
        }
    }

    pub fn set_source(&self, text: String) {
        let mut guard = self.source.lock().unwrap();
        *guard = Source::new(self.main, text);
    }
}

impl World for MathWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main {
            Ok(self.source.lock().unwrap().clone())
        } else {
            Err(FileError::NotFound(id.vpath().get_without_slash().into()))
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        Err(FileError::NotFound(id.vpath().get_without_slash().into()))
    }

    fn font(&self, _index: usize) -> Option<Font> {
        None
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        // Math-only documents never observe the current date.
        None
    }
}
