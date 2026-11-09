//! Minimal Node-API v1 binding for the upstream tryLock(fd, callback) contract.
use std::ffi::{c_char, c_void};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicI32, Ordering};

// Opaque handles from Node's js_native_api_types.h and node_api_types.h.
type Handle = *mut c_void;
type Status = i32;
type Callback = unsafe extern "C" fn(Handle, Handle) -> Handle;
type Execute = unsafe extern "C" fn(Handle, *mut c_void);
type Complete = unsafe extern "C" fn(Handle, Status, *mut c_void);
const OK: Status = 0;

extern "C" {
    fn napi_get_cb_info(
        env: Handle,
        info: Handle,
        argc: *mut usize,
        argv: *mut Handle,
        this_arg: *mut Handle,
        data: *mut *mut c_void,
    ) -> Status;
    fn napi_get_value_int32(env: Handle, value: Handle, result: *mut i32) -> Status;
    fn napi_create_string_utf8(
        env: Handle,
        value: *const c_char,
        len: usize,
        result: *mut Handle,
    ) -> Status;
    fn napi_create_reference(
        env: Handle,
        value: Handle,
        initial: u32,
        result: *mut Handle,
    ) -> Status;
    fn napi_delete_reference(env: Handle, reference: Handle) -> Status;
    fn napi_get_reference_value(env: Handle, reference: Handle, result: *mut Handle) -> Status;
    fn napi_get_undefined(env: Handle, result: *mut Handle) -> Status;
    fn napi_create_int32(env: Handle, value: i32, result: *mut Handle) -> Status;
    fn napi_call_function(
        env: Handle,
        receiver: Handle,
        function: Handle,
        argc: usize,
        argv: *const Handle,
        result: *mut Handle,
    ) -> Status;
    fn napi_create_async_work(
        env: Handle,
        resource: Handle,
        name: Handle,
        execute: Execute,
        complete: Complete,
        data: *mut c_void,
        result: *mut Handle,
    ) -> Status;
    fn napi_queue_async_work(env: Handle, work: Handle) -> Status;
    fn napi_delete_async_work(env: Handle, work: Handle) -> Status;
    fn napi_create_function(
        env: Handle,
        name: *const c_char,
        len: usize,
        function: Callback,
        data: *mut c_void,
        result: *mut Handle,
    ) -> Status;
    fn napi_set_named_property(
        env: Handle,
        object: Handle,
        name: *const c_char,
        value: Handle,
    ) -> Status;
    fn napi_throw_error(env: Handle, code: *const c_char, message: *const c_char) -> Status;
}

struct Work {
    fd: i32,
    errno: AtomicI32,
    callback: Handle,
    work: Handle,
}

unsafe extern "C" fn acquire(_env: Handle, data: *mut c_void) {
    // The owner keeps fd open until completion. LOCK_NB never waits for a peer.
    let work = &*data.cast::<Work>();
    let status = libc::flock(work.fd, libc::LOCK_EX | libc::LOCK_NB);
    let errno = if status == 0 {
        0
    } else {
        std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::EIO)
    };
    work.errno.store(errno, Ordering::Release);
}

unsafe extern "C" fn finish(env: Handle, status: Status, data: *mut c_void) {
    // Only completion or failed scheduling reclaims the original allocation.
    let work = Box::from_raw(data.cast::<Work>());
    if env.is_null() {
        return;
    }
    let errno = if status == OK {
        work.errno.load(Ordering::Acquire)
    } else {
        libc::ECANCELED
    };
    let (mut function, mut receiver, mut result) = (null_mut(), null_mut(), null_mut());
    let ready = napi_get_reference_value(env, work.callback, &mut function) == OK
        && napi_get_undefined(env, &mut receiver) == OK
        && napi_create_int32(env, errno, &mut result) == OK;
    napi_delete_reference(env, work.callback);
    napi_delete_async_work(env, work.work);
    if ready {
        napi_call_function(env, receiver, function, 1, &result, null_mut());
    }
}

unsafe extern "C" fn try_lock(env: Handle, info: Handle) -> Handle {
    let mut argc = 2;
    let mut argv = [null_mut(); 2];
    let mut fd = -1;
    let (mut callback, mut name) = (null_mut(), null_mut());
    if napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        null_mut(),
        null_mut(),
    ) != OK
        || argc != 2
        || napi_get_value_int32(env, argv[0], &mut fd) != OK
        || napi_create_string_utf8(env, c"dsh.flock".as_ptr(), 9, &mut name) != OK
        || napi_create_reference(env, argv[1], 1, &mut callback) != OK
    {
        napi_throw_error(
            env,
            null(),
            c"tryLock expects a descriptor and callback".as_ptr(),
        );
        return null_mut();
    }
    let data = Box::into_raw(Box::new(Work {
        fd,
        errno: AtomicI32::new(libc::EIO),
        callback,
        work: null_mut(),
    }));
    let created = napi_create_async_work(
        env,
        null_mut(),
        name,
        acquire,
        finish,
        data.cast(),
        &mut (*data).work,
    ) == OK;
    if created && napi_queue_async_work(env, (*data).work) == OK {
        return null_mut();
    }
    if created {
        napi_delete_async_work(env, (*data).work);
    }
    napi_delete_reference(env, callback);
    drop(Box::from_raw(data));
    napi_throw_error(env, null(), c"cannot schedule flock".as_ptr());
    null_mut()
}

/// # Safety
/// Called only by Node with handles belonging to the current environment.
#[no_mangle]
pub unsafe extern "C" fn napi_register_module_v1(env: Handle, exports: Handle) -> Handle {
    let name = c"tryLock".as_ptr();
    let mut function = null_mut();
    if napi_create_function(env, name, 7, try_lock, null_mut(), &mut function) != OK
        || napi_set_named_property(env, exports, name, function) != OK
    {
        napi_throw_error(env, null(), c"cannot initialize Android flock".as_ptr());
        return null_mut();
    }
    exports
}
