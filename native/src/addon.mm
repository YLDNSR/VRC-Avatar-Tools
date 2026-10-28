// Native helpers for VRC Avatar Tools.
//  - Shared-memory frame writer for the Syphon helper process (BGRA, top-down rows)
//  - Global modifier-key state (no permission required)
//  - Listen-only global key monitor (needs Input Monitoring permission)

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <IOSurface/IOSurface.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreVideo/CoreVideo.h>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#include "shm.h"

#include <napi.h>
#include <thread>
#include <atomic>

// ---------------------------------------------------------------------------
// Shared-memory frame writer (the Syphon helper process reads and publishes it).

static uint8_t *gShm = nullptr;

static Napi::Value ShmOpen(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (gShm) { munmap(gShm, VAV_SHM_TOTAL); gShm = nullptr; }
    if (info.Length() < 1 || !info[0].IsString()) return Napi::Boolean::New(env, false);
    std::string path = info[0].As<Napi::String>().Utf8Value();
    int fd = open(path.c_str(), O_RDWR);
    if (fd < 0) return Napi::Boolean::New(env, false);
    void *map = mmap(NULL, VAV_SHM_TOTAL, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (map == MAP_FAILED) return Napi::Boolean::New(env, false);
    gShm = (uint8_t *)map;
    return Napi::Boolean::New(env, true);
}

static Napi::Value ShmClose(const Napi::CallbackInfo &info)
{
    if (gShm) { munmap(gShm, VAV_SHM_TOTAL); gShm = nullptr; }
    return info.Env().Undefined();
}

// shmWrite(Uint8Array bgra, width, height): copies into the next slot, then publishes it.
static Napi::Value ShmWrite(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (!gShm || info.Length() < 3 || !info[0].IsTypedArray()) return Napi::Boolean::New(env, false);
    Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
    const uint8_t *data = (const uint8_t *)ta.ArrayBuffer().Data() + ta.ByteOffset();
    size_t length = ta.ByteLength();
    uint32_t w = info[1].As<Napi::Number>().Uint32Value();
    uint32_t h = info[2].As<Napi::Number>().Uint32Value();
    uint64_t bytes = (uint64_t)w * h * 4;
    if (bytes == 0 || bytes > VAV_SHM_SLOT_SIZE || length < bytes) return Napi::Boolean::New(env, false);
    VAVShmHeader *hdr = (VAVShmHeader *)gShm;
    uint64_t next = __atomic_load_n(&hdr->seq, __ATOMIC_ACQUIRE) + 1;
    uint32_t slot = (uint32_t)(next & 1);
    memcpy(gShm + VAV_SHM_HEADER_SIZE + slot * VAV_SHM_SLOT_SIZE, data, bytes);
    hdr->width[slot] = w;
    hdr->height[slot] = h;
    __atomic_store_n(&hdr->seq, next, __ATOMIC_RELEASE);
    return Napi::Boolean::New(env, true);
}

static Napi::Value ShmStatus(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    Napi::Object o = Napi::Object::New(env);
    if (!gShm) { o.Set("open", false); return o; }
    VAVShmHeader *hdr = (VAVShmHeader *)gShm;
    o.Set("open", true);
    o.Set("ready", __atomic_load_n(&hdr->helperReady, __ATOMIC_ACQUIRE) != 0);
    o.Set("clients", __atomic_load_n(&hdr->hasClients, __ATOMIC_ACQUIRE) != 0);
    o.Set("seq", (double)__atomic_load_n(&hdr->seq, __ATOMIC_ACQUIRE));
    return o;
}

// ---------------------------------------------------------------------------
// Modifier key state.

// Device-dependent bits from IOKit/hidsystem/IOLLEvent.h
#define VAV_DEVICE_LCTL   0x00000001
#define VAV_DEVICE_LSHIFT 0x00000002
#define VAV_DEVICE_RSHIFT 0x00000004
#define VAV_DEVICE_LCMD   0x00000008
#define VAV_DEVICE_RCMD   0x00000010
#define VAV_DEVICE_LALT   0x00000020
#define VAV_DEVICE_RALT   0x00000040
#define VAV_DEVICE_RCTL   0x00002000

static Napi::Object FlagsToObject(Napi::Env env, uint64_t flags)
{
    Napi::Object o = Napi::Object::New(env);
    o.Set("shift", (flags & kCGEventFlagMaskShift) != 0);
    o.Set("control", (flags & kCGEventFlagMaskControl) != 0);
    o.Set("alt", (flags & kCGEventFlagMaskAlternate) != 0);
    o.Set("command", (flags & kCGEventFlagMaskCommand) != 0);
    o.Set("fn", (flags & kCGEventFlagMaskSecondaryFn) != 0);
    o.Set("leftShift", (flags & VAV_DEVICE_LSHIFT) != 0);
    o.Set("rightShift", (flags & VAV_DEVICE_RSHIFT) != 0);
    o.Set("leftControl", (flags & VAV_DEVICE_LCTL) != 0);
    o.Set("rightControl", (flags & VAV_DEVICE_RCTL) != 0);
    o.Set("leftAlt", (flags & VAV_DEVICE_LALT) != 0);
    o.Set("rightAlt", (flags & VAV_DEVICE_RALT) != 0);
    o.Set("leftCommand", (flags & VAV_DEVICE_LCMD) != 0);
    o.Set("rightCommand", (flags & VAV_DEVICE_RCMD) != 0);
    return o;
}

static Napi::Value GetModifierFlags(const Napi::CallbackInfo &info)
{
    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    return FlagsToObject(info.Env(), (uint64_t)flags);
}

static Napi::Value GetMouseButtons(const Napi::CallbackInfo &info)
{
    NSUInteger buttons = [NSEvent pressedMouseButtons];
    return Napi::Number::New(info.Env(), (double)buttons);
}

// ---------------------------------------------------------------------------
// Global key monitor (listen only; does not swallow events).

struct KeyEventData
{
    int keyCode;
    bool down;
    uint64_t flags;
};

static Napi::ThreadSafeFunction gKeyTsfn;
static std::atomic<bool> gKeyMonitorRunning(false);
static CFRunLoopRef gKeyRunLoop = NULL;
static CFMachPortRef gKeyTap = NULL;
static std::thread gKeyThread;

static CGEventRef KeyTapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *refcon)
{
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput)
    {
        if (gKeyTap) CGEventTapEnable(gKeyTap, true);
        return event;
    }
    if (type != kCGEventKeyDown && type != kCGEventKeyUp && type != kCGEventFlagsChanged) return event;
    if (type == kCGEventKeyDown && CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0) return event;
    KeyEventData *data = new KeyEventData();
    data->keyCode = (int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
    data->down = (type == kCGEventKeyDown);
    data->flags = (uint64_t)CGEventGetFlags(event);
    if (type == kCGEventFlagsChanged) data->down = false;
    napi_status status = gKeyTsfn.NonBlockingCall(data, [type](Napi::Env env, Napi::Function cb, KeyEventData *d) {
        Napi::Object o = Napi::Object::New(env);
        o.Set("keyCode", d->keyCode);
        o.Set("type", type == kCGEventFlagsChanged ? "flags" : (d->down ? "down" : "up"));
        o.Set("modifiers", FlagsToObject(env, d->flags));
        cb.Call({o});
        delete d;
    });
    if (status != napi_ok) delete data;
    return event;
}

static Napi::Value InputMonitoringAccess(const Napi::CallbackInfo &info)
{
    bool request = info.Length() > 0 && info[0].ToBoolean().Value();
    bool granted = CGPreflightListenEventAccess();
    if (!granted && request) granted = CGRequestListenEventAccess();
    return Napi::Boolean::New(info.Env(), granted);
}

static Napi::Value KeyMonitorStart(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    if (gKeyMonitorRunning) return Napi::Boolean::New(env, true);
    if (info.Length() < 1 || !info[0].IsFunction()) return Napi::Boolean::New(env, false);
    if (!CGPreflightListenEventAccess()) return Napi::Boolean::New(env, false);

    CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged);
    CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, KeyTapCallback, NULL);
    if (!tap) return Napi::Boolean::New(env, false);

    gKeyTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(), "vavKeyMonitor", 0, 1);
    gKeyTap = tap;
    gKeyMonitorRunning = true;
    gKeyThread = std::thread([tap]() {
        @autoreleasepool
        {
            CFRunLoopSourceRef src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
            gKeyRunLoop = CFRunLoopGetCurrent();
            CFRetain(gKeyRunLoop);
            CFRunLoopAddSource(gKeyRunLoop, src, kCFRunLoopCommonModes);
            CGEventTapEnable(tap, true);
            CFRunLoopRun();
            CFRunLoopRemoveSource(gKeyRunLoop, src, kCFRunLoopCommonModes);
            CFRelease(src);
        }
    });
    return Napi::Boolean::New(env, true);
}

static void StopKeyMonitorInternal()
{
    if (!gKeyMonitorRunning) return;
    gKeyMonitorRunning = false;
    if (gKeyTap) CGEventTapEnable(gKeyTap, false);
    // Wait for the thread to publish its run loop before stopping it.
    for (int i = 0; i < 100 && gKeyRunLoop == NULL; i++) usleep(1000);
    if (gKeyRunLoop) CFRunLoopStop(gKeyRunLoop);
    if (gKeyThread.joinable()) gKeyThread.join();
    if (gKeyRunLoop) { CFRelease(gKeyRunLoop); gKeyRunLoop = NULL; }
    if (gKeyTap) { CFMachPortInvalidate(gKeyTap); CFRelease(gKeyTap); gKeyTap = NULL; }
    gKeyTsfn.Release();
}

static Napi::Value KeyMonitorStop(const Napi::CallbackInfo &info)
{
    StopKeyMonitorInternal();
    return info.Env().Undefined();
}

// ---------------------------------------------------------------------------

static Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("shmOpen", Napi::Function::New(env, ShmOpen));
    exports.Set("shmClose", Napi::Function::New(env, ShmClose));
    exports.Set("shmWrite", Napi::Function::New(env, ShmWrite));
    exports.Set("shmStatus", Napi::Function::New(env, ShmStatus));
    exports.Set("getModifierFlags", Napi::Function::New(env, GetModifierFlags));
    exports.Set("getMouseButtons", Napi::Function::New(env, GetMouseButtons));
    exports.Set("inputMonitoringAccess", Napi::Function::New(env, InputMonitoringAccess));
    exports.Set("keyMonitorStart", Napi::Function::New(env, KeyMonitorStart));
    exports.Set("keyMonitorStop", Napi::Function::New(env, KeyMonitorStop));
    env.AddCleanupHook([]() { StopKeyMonitorInternal(); });
    return exports;
}

NODE_API_MODULE(vav_native, Init)
