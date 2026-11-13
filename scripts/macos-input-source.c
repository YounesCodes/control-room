// Native input-source selection and key mapping for the disposable desktop lab.
#include <Carbon/Carbon.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void fail(const char *message) { fprintf(stderr, "%s\n", message); exit(1); }
static TISInputSourceRef source(const char *identifier) {
  CFArrayRef sources = TISCreateInputSourceList(NULL, true);
  if (!sources) fail("Could not enumerate native input sources");
  TISInputSourceRef found = NULL;
  for (CFIndex index = 0; index < CFArrayGetCount(sources); index++) {
    TISInputSourceRef item = (TISInputSourceRef)CFArrayGetValueAtIndex(sources, index);
    CFStringRef id = (CFStringRef)TISGetInputSourceProperty(item, kTISPropertyInputSourceID);
    char text[1024];
    if (id && CFStringGetCString(id, text, sizeof(text), kCFStringEncodingUTF8) && !strcmp(text, identifier)) { found = item; CFRetain(found); break; }
  }
  CFRelease(sources);
  if (!found) fail("The requested native input source is not installed");
  return found;
}
static int enabled(TISInputSourceRef item) {
  CFBooleanRef value = (CFBooleanRef)TISGetInputSourceProperty(item, kTISPropertyInputSourceIsEnabled);
  return value && CFBooleanGetValue(value);
}
static int key_for(const UCKeyboardLayout *layout, UniChar expected, int dead) {
  const UInt32 modifiers[] = {0, shiftKey >> 8, optionKey >> 8, (shiftKey | optionKey) >> 8};
  for (size_t modifier = 0; modifier < 4; modifier++) for (UInt16 key = 0; key < 128; key++) {
    UInt32 state = 0; UniChar result[8]; UniCharCount count = 0;
    OSStatus status = UCKeyTranslate(layout, key, kUCKeyActionDown, modifiers[modifier], LMGetKbdType(), 0, &state, 8, &count, result);
    if (status != noErr) continue;
    if (dead) {
      if (!state) continue;
      status = UCKeyTranslate(layout, 14, kUCKeyActionDown, 0, LMGetKbdType(), 0, &state, 8, &count, result);
    } else if (state) continue;
    if (status == noErr && count == 1 && result[0] == expected) {
      printf("{\"key\":%u,\"shift\":%s,\"option\":%s}", key, (modifiers[modifier] & (shiftKey >> 8)) ? "true" : "false", (modifiers[modifier] & (optionKey >> 8)) ? "true" : "false");
      return 1;
    }
  }
  return 0;
}
int main(int argc, char **argv) {
  if (argc < 2) fail("Expected desktop, current, enabled, select, disable, or keys");
  if (!strcmp(argv[1], "desktop")) {
    // Synthetic keys and clicks need an unlocked console session and Accessibility approval.
    CFDictionaryRef session = CGSessionCopyCurrentDictionary();
    CFBooleanRef locked = session ? (CFBooleanRef)CFDictionaryGetValue(session, CFSTR("CGSSessionScreenIsLocked")) : NULL;
    printf("{\"session\":%s,\"locked\":%s,\"accessibility\":%s}\n", session ? "true" : "false", locked && CFBooleanGetValue(locked) ? "true" : "false", AXIsProcessTrusted() ? "true" : "false");
    if (session) CFRelease(session);
    return 0;
  }
  if (!strcmp(argv[1], "current")) {
    TISInputSourceRef item = TISCopyCurrentKeyboardInputSource();
    char text[1024];
    CFStringRef id = (CFStringRef)TISGetInputSourceProperty(item, kTISPropertyInputSourceID);
    if (!id || !CFStringGetCString(id, text, sizeof(text), kCFStringEncodingUTF8)) fail("Current source ID is unavailable");
    puts(text); CFRelease(item); return 0;
  }
  if (!strcmp(argv[1], "keys")) {
    TISInputSourceRef item = TISCopyCurrentKeyboardLayoutInputSource();
    CFDataRef data = (CFDataRef)TISGetInputSourceProperty(item, kTISPropertyUnicodeKeyLayoutData);
    if (!data) fail("The selected source has no native Unicode key map");
    const UCKeyboardLayout *layout = (const UCKeyboardLayout *)CFDataGetBytePtr(data);
    printf("{\"grave\":"); if (!key_for(layout, 0x00e8, 0)) fail("The Italian map has no direct e-grave key");
    printf(",\"acute\":"); if (!key_for(layout, 0x00e9, 1)) fail("The Italian map has no dead-key e-acute sequence");
    puts("}"); CFRelease(item); return 0;
  }
  if (argc != 3) fail("Expected one input-source identifier");
  TISInputSourceRef item = source(argv[2]);
  OSStatus status = noErr;
  if (!strcmp(argv[1], "enabled")) printf("%d\n", enabled(item));
  else if (!strcmp(argv[1], "select")) {
    if (!enabled(item)) status = TISEnableInputSource(item);
    if (status == noErr) status = TISSelectInputSource(item);
  } else if (!strcmp(argv[1], "disable")) status = TISDisableInputSource(item);
  else fail("Unknown input-source operation");
  CFRelease(item);
  if (status != noErr) { fprintf(stderr, "Input-source operation failed: %d\n", (int)status); return 1; }
  return 0;
}
