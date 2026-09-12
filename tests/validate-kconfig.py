import io
import itertools
import json
import pathlib
import sys
import types

sys.dont_write_bytecode = True
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
source = pathlib.Path(__file__).with_name("fixtures").joinpath("kconfiglib.py").read_text(encoding="utf-8")
module = types.ModuleType("kconfiglib")
module.__file__ = "kconfiglib.py"
sys.modules["kconfiglib"] = module
exec(compile(source, "kconfiglib.py", "exec"), module.__dict__)


class MemoryKconfig(module.Kconfig):
    def __init__(self, text):
        self.text = 'mainmenu "Test"\nconfig MODULES\n\tbool\n\toption modules\n\tdefault y\n' + text
        super().__init__("Kconfig", warn=False)

    def _open(self, filename, mode):
        if mode == "r" and pathlib.Path(filename).resolve() == pathlib.Path("Kconfig").resolve():
            return io.StringIO(self.text)
        if mode == "r" and pathlib.Path(filename).resolve() == pathlib.Path("package/test/image-config.in").resolve():
            return io.StringIO("")
        raise RuntimeError("Unexpected file access: " + filename)


results = []
for case in json.load(sys.stdin):
    MemoryKconfig(case["text"])
    checked = 0
    for alpha, meta, nikki in itertools.product(range(3), repeat=3):
        config = MemoryKconfig(case["text"])
        config.syms[case["alpha"]].set_value(alpha)
        config.syms[case["meta"]].set_value(meta)
        config.syms["PACKAGE_nikki"].set_value(nikki)
        actual_alpha = config.syms[case["alpha"]].tri_value
        actual_meta = config.syms[case["meta"]].tri_value
        actual_nikki = config.syms["PACKAGE_nikki"].tri_value
        assert not (actual_alpha == 2 and actual_meta == 2), case["name"]
        assert actual_nikki == nikki, (case["name"], alpha, meta, nikki)
        assert actual_nikki <= max(actual_alpha, actual_meta), case["name"]
        if alpha == 2 and meta == 0 and nikki == 0:
            assert actual_alpha == 2, case["name"]
        if meta == 2 and alpha == 0 and nikki == 0:
            assert actual_meta == 2, case["name"]
        checked += 1
    results.append({"name": case["name"], "statesChecked": checked})
print(json.dumps(results))
