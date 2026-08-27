# San Ve Radar server

Bản thử nghiệm gồm API, lưu hành trình, worker chạy mỗi 15 phút và danh sách adapter hãng bay.

## Chạy local

```text
npm install
npm start
```

`GET /health`, `GET /providers`, `GET /itineraries`, `POST /itineraries`.

## Kho lịch sử nhiều chặng

NRT–HAN vẫn được phủ sẵn một năm. Các chặng khác được thêm tự động khi người
dùng tìm giá, mở trang lịch sử hoặc bấm theo dõi. Cách này hỗ trợ chặng quốc tế
với Việt Nam, nội địa Việt Nam, nội địa Nhật Bản và mọi cặp mã IATA hợp lệ mà
không quét mù hàng nghìn chặng không có người dùng.

Mỗi lô xử lý tối đa 12 tổ hợp chặng–ngày. Lịch GitHub Actions gọi một lô mỗi 20
phút. Hãng bay được nhận diện động từ kết quả Google Flights, không còn khóa ở
bốn hãng. Mỗi thay đổi giá được lưu; phiên giống hệt trước đó bị bỏ qua. Dữ
liệu của ngày bay chỉ bị xóa sau khi ngày đó đã qua theo giờ Tokyo.

- `POST /archive/run` với `{ "limit": 12 }`: quét lô ngày đến hạn tiếp theo.
- `POST /archive/routes`: thêm chặng và khoảng ngày cần theo dõi.
- `GET /archive/routes`: danh sách chặng đã được kích hoạt.
- `GET /archive/status?origin=SGN&destination=DAD`: tiến độ của một chặng.
- `GET /archive/calendar?origin=HND&destination=CTS&from=2026-09-01&to=2026-09-30`: giá mới nhất.
- `GET /archive/history?origin=CDG&destination=HAN&from=2026-09-01&to=2026-09-30`: lịch sử một chặng.

## Kho dự phòng và tự chuyển khi kho chính hết hạn

Đặt `DATABASE_URL` cho PostgreSQL chính và `BACKUP_DATABASE_URL` cho PostgreSQL
dự phòng. Mỗi lần ghi sẽ được sao chép sang cả hai kho. Nếu kho chính không thể
kết nối, máy chủ tự đọc và tiếp tục ghi vào kho dự phòng. Chạy `npm run backup`
hoặc gọi `POST /archive/backup` với header `x-admin-key` để sao chép toàn bộ dữ
liệu ngay lập tức. Workflow `archive-backup.yml` chạy hằng ngày khi GitHub có
secret `ARCHIVE_ADMIN_KEY` trùng với biến trên Render.

Cơ chế này không tự đăng ký tài khoản đám mây mới. Cần tạo trước một PostgreSQL
miễn phí và cung cấp URL một lần; sau đó việc sao lưu và chuyển khi lỗi diễn ra
tự động. Khi không có PostgreSQL, máy chủ dùng tệp `DATA_DIR` chỉ để thử nghiệm.

Ngoài ra, `GET /archive/export` xuất toàn bộ kho lịch sử dưới dạng JSON nén.
Workflow `archive-backup.yml` tải tệp này mỗi ngày và thay thế tài sản
`latest-history.json.gz` trong GitHub Release `fare-archive-backup`. Bản sao này
hoạt động ngay cả khi chưa có PostgreSQL dự phòng và dùng để khôi phục nếu dịch
vụ miễn phí xóa kho chính.

## Lưu ý về quét hãng

Không có một giao diện tìm kiếm chung cho tất cả hãng. Mỗi adapter phải được kiểm thử riêng, tuân thủ điều khoản truy cập của hãng, giới hạn tốc độ và xử lý CAPTCHA/anti-bot bằng cách dừng an toàn — không vượt qua biện pháp bảo vệ. Adapter hiện là khung để nối từng hãng sau khi xác định trang giá công khai và selector ổn định.
