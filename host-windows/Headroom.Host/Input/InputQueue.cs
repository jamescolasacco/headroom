namespace Headroom.Host.Input;

/// <summary>Only adjacent absolute moves are interchangeable. A button, wheel, key or relative
/// move must see the cursor position that preceded it, even when the input thread falls behind.</summary>
internal sealed class InputQueue(int capacity)
{
    private readonly LinkedList<Action> _events = new();
    private bool _tailIsMove;

    public void Post(Action action, bool absoluteMove = false)
    {
        lock (_events)
        {
            while (true)
            {
                if (absoluteMove && _tailIsMove)
                {
                    _events.Last!.Value = action;
                    return;
                }
                if (_events.Count < capacity) break;
                Monitor.Wait(_events);
            }

            _events.AddLast(action);
            _tailIsMove = absoluteMove;
            Monitor.PulseAll(_events);
        }
    }

    public Action Take()
    {
        lock (_events)
        {
            while (_events.Count == 0) Monitor.Wait(_events);
            var action = _events.First!.Value;
            _events.RemoveFirst();
            if (_events.Count == 0) _tailIsMove = false;
            Monitor.PulseAll(_events);
            return action;
        }
    }
}
