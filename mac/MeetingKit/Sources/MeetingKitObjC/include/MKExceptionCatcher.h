#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs a block and turns an Objective-C exception into an NSError.
///
/// AVAudioEngine reports some failures (a tap with a format the hardware no
/// longer has, a node that lost its device) by raising NSException, which
/// Swift cannot catch and which would end the process in the middle of a
/// meeting.
FOUNDATION_EXPORT BOOL MKTryBlock(void (NS_NOESCAPE ^block)(void), NSError *_Nullable *_Nullable error);

NS_ASSUME_NONNULL_END
