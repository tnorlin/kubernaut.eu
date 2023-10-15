## 

### Authentication

    $ echo "$USER:$(openssl passwd Passw0rd)" > /etc/nginx.d/passwd
    $ grep -A4 location /etc/nginx/nginx.conf
        location / {
            auth_basic          "Login Required";
            auth_basic_user_file conf.d/passwd;
        }
