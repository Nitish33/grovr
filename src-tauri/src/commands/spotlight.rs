//! Exposes quick links to Spotlight so typing `dev:<name>` opens the link directly.
//!
//! Items are indexed through CoreSpotlight under the app's own bundle, so macOS drops them when
//! the app is uninstalled. Removed or renamed links are deleted from the index on every sync.

use crate::types::QuickLinkItem;

#[cfg(target_os = "macos")]
mod imp {
    use super::QuickLinkItem;
    use crate::commands::links::open_url;
    use crate::commands::settings::SettingsState;
    use block::ConcreteBlock;
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSString};
    use objc::runtime::{object_getClass, Class, Imp, Object, Sel, BOOL, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;
    use std::sync::OnceLock;
    use tauri::Manager;

    #[link(name = "CoreSpotlight", kind = "framework")]
    unsafe extern "C" {}

    const DOMAIN: &str = "app.grovr.quick-links";
    const PREFIX: &str = "dev:";
    const ACTIVITY_TYPE: &str = "com.apple.corespotlightitem";
    const IDENTIFIER_KEY: &str = "kCSSearchableItemActivityIdentifier";

    unsafe extern "C" {
        fn class_replaceMethod(
            cls: *mut Class,
            name: Sel,
            imp: Imp,
            types: *const std::os::raw::c_char,
        ) -> Option<Imp>;
    }

    type ContinueActivity = unsafe extern "C" fn(&Object, Sel, id, id, id) -> BOOL;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    /// tao's own handler (web links); everything that isn't a Spotlight click is forwarded to it
    static ORIGINAL: OnceLock<Option<ContinueActivity>> = OnceLock::new();

    /// Autoreleased NSString; must be called inside an autorelease pool.
    unsafe fn ns(value: &str) -> id {
        let s: id = unsafe { NSString::alloc(nil).init_str(value) };
        unsafe { msg_send![s, autorelease] }
    }

    unsafe fn rust_string(value: id) -> Option<String> {
        if value == nil {
            return None;
        }
        let ptr: *const std::os::raw::c_char = unsafe { msg_send![value, UTF8String] };
        if ptr.is_null() {
            return None;
        }
        Some(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned())
    }

    pub fn sync(links: &[QuickLinkItem]) {
        objc::rc::autoreleasepool(|| unsafe {
            let index: id = msg_send![class!(CSSearchableIndex), defaultSearchableIndex];
            if index == nil {
                return;
            }

            let domains = NSArray::arrayWithObject(nil, ns(DOMAIN));
            let _: () = msg_send![index, deleteSearchableItemsWithDomainIdentifiers: domains
                                         completionHandler: nil];

            let items: id = msg_send![class!(NSMutableArray), array];
            for link in links {
                let title = format!("{}{}", PREFIX, link.name);
                let keywords = NSArray::arrayWithObjects(
                    nil,
                    &[ns(&title), ns(PREFIX), ns(&link.name)],
                );

                let attrs: id = msg_send![class!(CSSearchableItemAttributeSet), alloc];
                let attrs: id = msg_send![attrs, initWithItemContentType: ns("public.item")];
                let attrs: id = msg_send![attrs, autorelease];
                let _: () = msg_send![attrs, setTitle: ns(&title)];
                let _: () = msg_send![attrs, setDisplayName: ns(&title)];
                let _: () = msg_send![attrs, setContentDescription: ns(&link.url)];
                let _: () = msg_send![attrs, setKeywords: keywords];

                let item: id = msg_send![class!(CSSearchableItem), alloc];
                let item: id = msg_send![item, initWithUniqueIdentifier: ns(&link.id)
                                               domainIdentifier: ns(DOMAIN)
                                               attributeSet: attrs];
                let item: id = msg_send![item, autorelease];
                let _: () = msg_send![items, addObject: item];
            }

            let count: usize = msg_send![items, count];
            if count > 0 {
                let done = ConcreteBlock::new(move |error: id| {
                    if error == nil {
                        eprintln!("[spotlight] indexed {} quick links", count);
                    } else {
                        let desc: id = msg_send![error, localizedDescription];
                        eprintln!("[spotlight] indexing failed: {:?}", rust_string(desc));
                    }
                })
                .copy();
                let _: () = msg_send![index, indexSearchableItems: items completionHandler: &*done];
            }
        });
    }

    extern "C" fn continue_activity(
        this: &Object,
        sel: Sel,
        app: id,
        activity: id,
        restoration_handler: id,
    ) -> BOOL {
        objc::rc::autoreleasepool(|| unsafe {
            let kind = rust_string(msg_send![activity, activityType]);
            eprintln!("[spotlight] continue activity: {:?}", kind);
            if kind.as_deref() != Some(ACTIVITY_TYPE) {
                return match ORIGINAL.get().copied().flatten() {
                    Some(original) => original(this, sel, app, activity, restoration_handler),
                    None => objc::runtime::NO,
                };
            }
            let info: id = msg_send![activity, userInfo];
            if info == nil {
                return objc::runtime::NO;
            }
            let Some(link_id) = rust_string(msg_send![info, objectForKey: ns(IDENTIFIER_KEY)])
            else {
                return objc::runtime::NO;
            };
            let Some(app) = APP.get() else {
                return objc::runtime::NO;
            };

            let url = app.try_state::<SettingsState>().and_then(|state| {
                let settings = state.0.lock().ok()?;
                settings
                    .quick_links
                    .iter()
                    .find(|link| link.id == link_id)
                    .map(|link| link.url.clone())
            });
            if let Some(url) = url {
                if let Err(err) = open_url(app, &url) {
                    eprintln!("[spotlight] failed to open quick link: {}", err);
                }
            }
            YES
        })
    }

    /// Adds the Spotlight click handler to the app delegate (tao doesn't implement it).
    /// Must run on the main thread.
    pub fn install(app: tauri::AppHandle) {
        let _ = APP.set(app);
        unsafe {
            let ns_app: id = msg_send![class!(NSApplication), sharedApplication];
            let delegate: id = msg_send![ns_app, delegate];
            if delegate == nil {
                return;
            }
            let class = object_getClass(delegate as *const Object) as *mut Class;
            let imp: Imp = std::mem::transmute(
                continue_activity as extern "C" fn(&Object, Sel, id, id, id) -> BOOL,
            );
            let previous = class_replaceMethod(
                class,
                sel!(application:continueUserActivity:restorationHandler:),
                imp,
                c"c@:@@@".as_ptr(),
            );
            let _ = ORIGINAL.set(previous.map(|imp| std::mem::transmute::<Imp, ContinueActivity>(imp)));
            eprintln!("[spotlight] delegate hook installed (had original: {})", previous.is_some());
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{install, sync};

#[cfg(not(target_os = "macos"))]
pub fn install(_app: tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub fn sync(_links: &[QuickLinkItem]) {}
