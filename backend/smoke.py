"""Aşama 0 - duman testi.

T4 GPU'lu bir Modal konteyneri açar, nvidia-smi ve torch CUDA bilgilerini
döndürür. Sürekli sıcak konteyner yok (min_containers verilmiyor), boştayken
maliyet sıfırdır.

Çalıştırma:
    modal run backend/smoke.py
"""

import subprocess

import modal

# Duman testi için torch yeterli. Sürüm sabitlenmiş ki her çalıştırmada
# farklı bir wheel inip sonucu değiştirmesin.
image = modal.Image.debian_slim(python_version="3.11").pip_install("torch==2.11.0")

app = modal.App("stem-mikser-smoke", image=image)

# Yerel ortamda torch/numpy kurulu değil; uzaktan dönen değerlerde bu
# kütüphanelerin tipleri kalırsa DeserializationError alırız. İzin verilen
# tipler bunlar (PLAN.md'deki kural).
SCALAR_TYPES = (str, int, float, bool, type(None))


def _assert_plain(value, path: str = "return"):
    """Değerin (ve içindeki her şeyin) düz Python tipi olduğunu doğrular.

    bool int'in, TorchVersion ise str'in alt sınıfı olduğu için isinstance
    yetmez; tipin TAM olarak izinli olmasını istiyoruz.
    """
    kind = type(value)
    if kind is dict:
        for key, item in value.items():
            _assert_plain(key, f"{path}[key]")
            _assert_plain(item, f"{path}[{key!r}]")
    elif kind in (list, tuple):
        for i, item in enumerate(value):
            _assert_plain(item, f"{path}[{i}]")
    elif kind not in SCALAR_TYPES:
        raise TypeError(
            f"{path} düz tip değil: {kind.__module__}.{kind.__name__}"
        )
    return value


@app.function(gpu="T4", timeout=300)
def gpu_check() -> dict:
    import torch

    smi = subprocess.run(["nvidia-smi"], capture_output=True, text=True)

    cuda_available = bool(torch.cuda.is_available())

    info = {
        "nvidia_smi_returncode": int(smi.returncode),
        "nvidia_smi": str(smi.stdout.strip() or smi.stderr.strip()),
        # torch.__version__ bir TorchVersion (str alt sınıfı) -> str()'e çevir.
        "torch_version": str(torch.__version__),
        # CUDA'sız derlemede None olabilir.
        "torch_cuda_version": None if torch.version.cuda is None else str(torch.version.cuda),
        "cuda_is_available": cuda_available,
        "device_count": int(torch.cuda.device_count()),
        "device_name": None,
        "device_total_memory_gb": None,
        "device_capability": None,
        "matmul_ok": None,
    }

    if cuda_available:
        props = torch.cuda.get_device_properties(0)
        info["device_name"] = str(torch.cuda.get_device_name(0))
        info["device_total_memory_gb"] = round(float(props.total_memory) / 1024**3, 2)
        info["device_capability"] = f"{int(props.major)}.{int(props.minor)}"
        # Gerçekten hesap yapabildiğini de doğrula.
        x = torch.randn(1024, 1024, device="cuda")
        info["matmul_ok"] = bool(torch.isfinite((x @ x).sum()).item())

    return _assert_plain(info)


@app.local_entrypoint()
def main():
    info = gpu_check.remote()

    print("\n===== nvidia-smi =====")
    print(info.pop("nvidia_smi"))

    print("\n===== torch =====")
    for key, value in info.items():
        print(f"{key}: {value}")

    if info.get("cuda_is_available"):
        print("\nSONUÇ: T4 GPU hazır, torch CUDA'yı görüyor.")
    else:
        print("\nSONUÇ: CUDA GÖRÜNMÜYOR - imaj veya GPU ayarı hatalı.")
