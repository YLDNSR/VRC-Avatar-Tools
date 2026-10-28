using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VRCAvatarTools.Exporter
{
    /// <summary>
    /// Minimal JSON writer (JsonUtility cannot write nested optional data). Indented unless compact.
    /// </summary>
    internal sealed class VavJsonWriter
    {
        readonly StringBuilder _sb = new StringBuilder();
        readonly bool _compact;
        // Number of values written in each open object / array.
        readonly Stack<int> _counts = new Stack<int>();
        bool _afterKey;

        public VavJsonWriter(bool compact = false)
        {
            _compact = compact;
        }

        public override string ToString() => _sb.ToString();

        void BeforeValue()
        {
            if (_afterKey) { _afterKey = false; return; }
            if (_counts.Count == 0) return;
            var n = _counts.Pop();
            if (n > 0) _sb.Append(',');
            _counts.Push(n + 1);
            NewLine();
        }

        void NewLine()
        {
            if (!_compact) _sb.Append('\n').Append(' ', _counts.Count * 2);
        }

        void Close(char c)
        {
            var n = _counts.Pop();
            if (n > 0) NewLine();
            _sb.Append(c);
        }

        public VavJsonWriter BeginObject() { BeforeValue(); _sb.Append('{'); _counts.Push(0); return this; }
        public VavJsonWriter EndObject() { Close('}'); return this; }
        public VavJsonWriter BeginArray() { BeforeValue(); _sb.Append('['); _counts.Push(0); return this; }
        public VavJsonWriter EndArray() { Close(']'); return this; }

        public VavJsonWriter Key(string key)
        {
            BeforeValue();
            WriteString(key);
            _sb.Append(_compact ? ":" : ": ");
            _afterKey = true;
            return this;
        }

        public VavJsonWriter Null() { BeforeValue(); _sb.Append("null"); return this; }

        public VavJsonWriter Value(string s)
        {
            BeforeValue();
            if (s == null) _sb.Append("null"); else WriteString(s);
            return this;
        }

        public VavJsonWriter Value(float f)
        {
            BeforeValue();
            if (float.IsNaN(f) || float.IsInfinity(f)) f = 0;
            _sb.Append(((double)f).ToString("0.#####", CultureInfo.InvariantCulture));
            return this;
        }

        /// <summary>Curve tangents: Unity marks stepped keys with infinite slopes, kept as ±1e9.</summary>
        public VavJsonWriter Slope(float f)
        {
            if (float.IsNaN(f)) f = 0;
            else if (float.IsInfinity(f) || f > 1e9f || f < -1e9f) f = f > 0 ? 1e9f : -1e9f;
            BeforeValue();
            _sb.Append(((double)f).ToString("0.#####", CultureInfo.InvariantCulture));
            return this;
        }

        /// <summary>Pre-formatted JSON value (number, base64 string, ...).</summary>
        public VavJsonWriter Raw(string json)
        {
            BeforeValue();
            _sb.Append(json);
            return this;
        }

        public VavJsonWriter Value(int i) { BeforeValue(); _sb.Append(i.ToString(CultureInfo.InvariantCulture)); return this; }
        public VavJsonWriter Value(bool b) { BeforeValue(); _sb.Append(b ? "true" : "false"); return this; }

        public VavJsonWriter Prop(string key, string value) => Key(key).Value(value);
        public VavJsonWriter Prop(string key, float value) => Key(key).Value(value);
        public VavJsonWriter Prop(string key, int value) => Key(key).Value(value);
        public VavJsonWriter Prop(string key, bool value) => Key(key).Value(value);

        void WriteString(string s)
        {
            _sb.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': _sb.Append("\\\""); break;
                    case '\\': _sb.Append("\\\\"); break;
                    case '\n': _sb.Append("\\n"); break;
                    case '\r': _sb.Append("\\r"); break;
                    case '\t': _sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) _sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else _sb.Append(c);
                        break;
                }
            }
            _sb.Append('"');
        }
    }
}
