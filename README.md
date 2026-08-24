# San Ve Radar server

Bản thử nghiệm gồm API, lưu hành trình, worker chạy mỗi 15 phút và danh sách adapter hãng bay.

## Chạy local

```text
npm install
npm start
```

`GET /health`, `GET /providers`, `GET /itineraries`, `POST /itineraries`.

## Kho lịch sử NRT–HAN

Máy chủ tạo 281 mục ngày từ 24/08/2026 đến 31/05/2027. Mỗi lô xử lý tối đa
12 ngày, lấy một lần dữ liệu Google Flights rồi lọc bốn hãng VJ, VN, NH và JL.
Lịch GitHub Actions gọi một lô mỗi 20 phút, tương đương khoảng ba lượt/ngày
cho từng ngày bay. Mỗi lần bảng giá thay đổi đều được lưu, không giới hạn số
phiên; phiên giống hệt lần trước bị bỏ qua. Toàn bộ lịch sử của một ngày chỉ
bị xóa sau khi ngày bay đó đã qua theo giờ Tokyo.

- `POST /archive/run` với `{ "limit": 12 }`: quét lô ngày đến hạn tiếp theo.
- `GET /archive/status`: tiến độ phủ ngày và trạng thái lần chạy gần nhất.
- `GET /archive/calendar?from=2026-08-24&to=2026-09-30`: giá mới nhất theo ngày.
- `GET /archive/history?date=2026-08-24&provider=VJ`: mọi lần thay đổi của ngày/hãng.
- `GET /archive/history?from=2026-09-01&to=2026-09-30`: lịch sử toàn bộ khoảng ngày.

Đặt `DATABASE_URL` tới PostgreSQL để dữ liệu tồn tại qua các lần Render khởi
động lại. Khi chưa có biến này, máy chủ dùng tệp trong `DATA_DIR`, phù hợp thử
nghiệm nhưng không phải kho lưu trữ lâu dài.

## Lưu ý về quét hãng

Không có một giao diện tìm kiếm chung cho tất cả hãng. Mỗi adapter phải được kiểm thử riêng, tuân thủ điều khoản truy cập của hãng, giới hạn tốc độ và xử lý CAPTCHA/anti-bot bằng cách dừng an toàn — không vượt qua biện pháp bảo vệ. Adapter hiện là khung để nối từng hãng sau khi xác định trang giá công khai và selector ổn định.
