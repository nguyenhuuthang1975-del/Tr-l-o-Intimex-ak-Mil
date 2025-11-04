# Intimex Đắk Mil – Bridge Server (ESP32 ↔ OpenAI)

Server nhỏ chạy trên VPS/Ubuntu để ESP32 gửi câu hỏi và nhận trả lời từ OpenAI.
Bạn **KHÔNG** cần là chuyên gia – làm theo các bước bên dưới.

## 1) Chuẩn bị
- Một máy chủ Linux (Ubuntu 22.04+), trỏ domain `intimexdakmil.com` về IP VPS.
- Tạo **OpenAI API key** tại https://platform.openai.com/ .
- Upload toàn bộ thư mục này lên máy chủ (SCP hoặc SFTP).

## 2) Cài đặt tự động
Trên máy chủ, chạy:
```bash
cd ~/intimex_bridge
sudo bash install.sh
```
Trình cài đặt sẽ:
- Cài Node.js (nếu chưa có), PM2.
- Hỏi bạn `OPENAI_API_KEY` và tạo file `.env`.
- Cấu hình Nginx reverse proxy `https://intimexdakmil.com` → `http://127.0.0.1:3000`
- Kích hoạt chứng chỉ SSL miễn phí (Let's Encrypt).
- Khởi động dịch vụ bằng PM2 (tự chạy lại khi máy khởi động).

> Sau khi xong, mở trình duyệt tới `https://intimexdakmil.com/health` để kiểm tra.

## 3) Điền nội dung trợ lý (bước quan trọng)
Mở file cấu hình:
```
config/assistant.yaml
```
- **system_prompt**: Dán nội dung hướng dẫn/kiến thức từ GPT của bạn (trên chatgpt.com).
- Bạn có thể sửa `model`, `temperature` theo nhu cầu.

> Lưu ý: Không thể “xuất” thẳng từ link GPT nội bộ. Hãy copy thủ công nội dung Instructions từ GPT đó vào đây.

Sau khi chỉnh sửa, khởi động lại dịch vụ:
```bash
pm2 restart intimex-bridge
```

## 4) Thử gọi API
Từ máy tính của bạn:
```bash
curl -X POST "https://intimexdakmil.com/chat"   -H "Content-Type: application/json"   -d '{ "message": "Xin chào trợ lý Intimex!", "device_id": "esp32-01" }'
```

Kết quả mẫu:
```json
{ "reply": "...", "model": "gpt-4.1-mini", "device_id": "esp32-01" }
```

## 5) ESP32 (Arduino) ví dụ rất ngắn
ESP32 chỉ cần POST JSON tới endpoint `/chat`:
```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "your-ssid";
const char* WIFI_PW   = "your-pass";
const char* SERVER_URL = "https://intimexdakmil.com/chat";

void setup() {
  Serial.begin(115200);
  WiFi.begin(WIFI_SSID, WIFI_PW);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nWiFi OK");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(SERVER_URL);
    http.addHeader("Content-Type", "application/json");
    String payload = R"({"device_id":"esp32-01","message":"Hôm nay có khuyến mãi gì?"})";
    int code = http.POST(payload);
    if (code > 0) {
      Serial.println(http.getString());
    } else {
      Serial.printf("HTTP error: %d\n", code);
    }
    http.end();
  }
  delay(10000);
}
```

## 6) Cấu trúc dự án
```
.
├── install.sh
├── package.json
├── server.js
├── .env.example
├── config
│   └── assistant.yaml
└── nginx
    └── site.conf
```

## 7) Bảo mật & vận hành
- **Không** để lộ API key trên ESP32 hay front-end.
- Hạn chế IP truy cập bằng tường lửa (nếu cần).
- Log nằm ở PM2: `pm2 logs intimex-bridge`
- Cập nhật: `git pull` (nếu bạn để source trong git) rồi `pm2 restart intimex-bridge`.

Chúc bạn triển khai thuận lợi!
