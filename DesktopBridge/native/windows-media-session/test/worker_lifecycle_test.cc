#include "../src/worker_lifecycle.h"

#include <cassert>
#include <stdexcept>

namespace {

struct Payload {
  int& destroyed;
  ~Payload() { ++destroyed; }
};

struct CallbackState {
  napi_status result;
  int sends = 0;
  int releases = 0;
  std::unique_ptr<Payload> queued;
};

struct TestCallback {
  CallbackState* state = nullptr;

  operator napi_threadsafe_function() const {
    return reinterpret_cast<napi_threadsafe_function>(state);
  }
  napi_status NonBlockingCall(Payload* payload) const {
    ++state->sends;
    if (state->result == napi_ok) state->queued.reset(payload);
    return state->result;
  }
  void Release() const { ++state->releases; }
};

void ClosingRetiresTheCallback() {
  int destroyed = 0;
  auto payload = Payload{destroyed};
  CallbackState state{napi_closing, 0, 0, nullptr};
  {
    auto owner = CallbackOwner(TestCallback{&state});
    owner.Send(payload);
    assert(!owner);
    owner.Send(payload);
  }
  assert(state.sends == 1);
  assert(state.releases == 0);
  assert(destroyed == 1);
}

void SuccessfulSendTransfersPayloadAndReleasesOnce() {
  int destroyed = 0;
  auto payload = Payload{destroyed};
  CallbackState state{napi_ok, 0, 0, nullptr};
  {
    auto pending = CallbackOwner(TestCallback{&state});
    auto worker = std::move(pending);
    worker.Send(payload);
    assert(!pending);
  }
  assert(state.sends == 1);
  assert(state.releases == 1);
  assert(destroyed == 0);
  state.queued.reset();
  assert(destroyed == 1);
}

void FirstPollTimeoutIsRecoverable() {
  bool running = true;
  int polls = 0;
  int errors = 0;
  int commands = 0;
  int waits = 0;
  RunRecoveringPolls(
      [&]() { return running; },
      [&]() {
        if (++polls == 1) throw std::runtime_error("metadata timeout");
      },
      [&](std::exception_ptr error) {
        try { std::rethrow_exception(error); }
        catch (const std::runtime_error&) { ++errors; }
      },
      [&]() { ++commands; },
      [&]() { running = ++waits < 2; });
  assert(polls == 2);
  assert(errors == 1);
  assert(commands == 2);
  assert(waits == 2);
}

void PartialSubscriptionsAreRevokedIndependently() {
  std::optional<int> timeline = 1;
  std::optional<int> playback = 2;
  std::optional<int> media;
  int attempted = 0;
  const auto revoke = [&](int token) {
    attempted |= token;
    if (token == 1) throw std::runtime_error("session disappeared");
  };
  RevokeEvent(timeline, revoke);
  RevokeEvent(playback, revoke);
  RevokeEvent(media, [](int) { assert(false); });
  RevokeEvent(timeline, [](int) { assert(false); });
  assert(attempted == 3);
  assert(!timeline && !playback && !media);
}

}  // namespace

int main() {
  ClosingRetiresTheCallback();
  SuccessfulSendTransfersPayloadAndReleasesOnce();
  FirstPollTimeoutIsRecoverable();
  PartialSubscriptionsAreRevokedIndependently();
}
