# San Ve Radar server

Bản thử nghiệm gồm API, lưu hành trình, worker chạy mỗi 15 phút và danh sách adapter hãng bay.

## Chạy local

```text
npm install
npm start
```

`GET /health`, `GET /providers`, `GET /itineraries`, `POST /itineraries`.

## Lưu ý về quét hãng

Không có một giao diện tìm kiếm chung cho tất cả hãng. Mỗi adapter phải được kiểm thử riêng, tuân thủ điều khoản truy cập của hãng, giới hạn tốc độ và xử lý CAPTCHA/anti-bot bằng cách dừng an toàn — không vượt qua biện pháp bảo vệ. Adapter hiện là khung để nối từng hãng sau khi xác định trang giá công khai và selector ổn định.
