using Headroom.Host.Input;

var queue = new InputQueue(8);
var actual = new List<string>();
var expected = new List<string>();
void Put(string text, bool move = false) => queue.Post(() => actual.Add(text), move);
var drain = Task.Run(() =>
{
    for (var i = 0; i < 1000; i++)
    {
        while (actual.Count == 0 || actual[^1] != "end " + i) queue.Take()();
    }
});
for (int i = 0; i < 1000; i++)
{
    // Timing can determine how many intermediate moves survive. The final position
    // before every non-move event must be exact.
    foreach (var action in new[] { "down", "wheel", "relative", "up" })
    {
        for (int x = 0; x < 20; x++) Put($"move {i} {action} {x}", true);
        Put(action);
        expected.Add($"move {i} {action} 19");
        expected.Add(action);
    }
    Put("end " + i);
}
await drain.WaitAsync(TimeSpan.FromSeconds(30));
var pairs = new List<string>();
for (int i = 0; i < actual.Count; i++)
{
    if (actual[i] is "down" or "wheel" or "relative" or "up")
        pairs.AddRange([actual[i - 1], actual[i]]);
}
if (!pairs.SequenceEqual(expected)) throw new Exception("Input ordering or delivery failed");
var burst = new InputQueue(2);
for (int i = 0; i < 10000; i++) { int x = i; burst.Post(() => actual.Add(x.ToString()), true); }
burst.Post(() => actual.Add("button up"));
burst.Take()();
burst.Take()();
if (actual[^2] != "9999" || actual[^1] != "button up") throw new Exception("Move burst lost its endpoint");
Console.WriteLine("Windows input queue: 80,000 moves interleaved with 4,000 actions passed");
