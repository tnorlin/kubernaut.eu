---
title: Kubernetes on FreeBSD with Linux worker nodes and Cilium
description: "This is the second part in a series where I describe how I set up a Kubernetes cluster on FreeBSD in my homelab. In this part we cover the worker nodes."
pubDatetime: 2024-01-12T21:26:14.164Z
draft: false
tags: []
---
![Laptop to be pimped up -- lots of space left for other stickers.](/assets/pimped-laptop.jpg)*<p align=center>Laptop to be pimped up -- lots of space left for other stickers.</p>*

*This is the second part in a series where I describe how I set up a Kubernetes cluster on FreeBSD in my homelab. If there happen to be  anyone worried that I've abandoned illumos - do not fear! I happen to enjoy working in anything illumos, Linux and BSD based… well, some of the "BSD" a bit less than the others - choosing A Poor File System (aka APFS) instead of ZFS seemed like a mistake in my viewpoint, Apple - I'm looking at you. I prefer the FFS in OpenBSD or NetBSD before APFS, but FreeBSD with OpenZFS is my top choice.*


*In the plans are to write down what I demoed a while ago on auto-join for worker nodes, and that will be in illumos. In the brain buffer there's some BGP related stuff as well, as more containerlab. A dozen of Kubernetes related projects that also should be dumped into words. And it's possible that I might have another announcement that I want to make before the summer.*

---

## Demo on YouTube around the concept

I recorded a demo of this concept on YouTube, and during creation of that demo I found some minor typos  that I've now revised in the first [article](https://kubernaut.eu/posts/welcome-mandala-kubernetes-v129-on-freebsd-controlplane):

[![Demo on how to run Kubernetes in FreeBSD together with bhyve guests](/assets/freebsd-youtube.png)](https://youtu.be/oj8JBWyHI4U)


The demo were intended to describe the first part, standing up a Kubernetes Control Plane in FreeBSD, but it seemed very thin to only do the components that literally just takes some minute. Hence, I decided to also add a working Data Plane prior to recording a video.

Basically the steps are as follows
- Creating the control plane as described in [part 1](https://kubernaut.eu/posts/welcome-mandala-kubernetes-v129-on-freebsd-controlplane)
- Download a cloud-image 
- Create storage backend to the guest
- Establish a cloud-init provisioner
- bootstrap the guest
- Create a template out of a snapshot taken from the guest
- bootstrap worker nodes from the template 


## Download a cloud-image

One Kubernetes friendly distribution of choice is Ubuntu and their Jammy 22.04 LTS images are great for cloud-init and bhyve.

```
cd /var/tmp
curl -LO https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img
qemu-img convert -O raw jammy-server-cloudimg-amd64.img jammy-server-cloudimg-amd64.img.raw
```

## Create storage backend to the guest

As the storage backend we will create a ZVOL

```
zfs create -V 10G -s -p dpool/bhyve/${guest}/root
```


## Establish a cloud-init provisioner for bhyve

### 9pfs as the shared storage
I'm used to run workloads with bhyve in illumos, but running it in FreeBSD was a rather new concept for me and at first I looked into vm-bhyve (and then the other bhyve related frontends available in FreeBSD), but they felt overly complicated for what I were going to use. Also they seemed to lack the support for cloud-init I needed for my project, so I went with vanilla bhyve instead.

Some year ago I would've proposed NFS as a shared storage between the hosts (both hypervisor and guests), but as of recently I've switch over to the Plan 9 protocols instead, which does this in a elegant fashion with the 9pfs.

9pfs just needs a directory of choice at the hypervisor, a configuration in bhyve and then the mount command within the guest and that's it.
### cloud-init from a NoCloud Metadata Server
In illumos I'm used to mount an ISO9660 with the related files by pointing to a user-data file from the zadm command and I have everything I need. But for some reason I had trouble enabling it in the FreeBSD implementation, even copying over a working seed image from my illumos hypervisors. But for the better good I decided to implement a NoCloud Metadata Server instead, as that actually simplified some of the stuff (but in turn introduced other, solvable, issues).


Initialize the NoCloud Metadata Server (seriously) by typing this in a shell:

```
mkdir /var/tmp/cloud-init
cd /var/tmp/cloud-init
python3.9 -m http.server
```


### Some minor issues 
During the boot there will be some expected issues that not affects the end result, such as:

```
[   22.107415] cloud-init[576]: 2024-01-12 06:35:43,750 - activators.py[WARNING]: Running ['netplan', 'apply'] resulted in stderr output:                                            
[   22.110197] cloud-init[576]: ** (generate:592): WARNING **: 08:35:33.847: Permissions for /etc/netplan/50-cloud-init.yaml are too open. Netplan configuration should NOT be access
ible by others.                                                                                                                                                                      
[   22.114005] cloud-init[576]: WARNING:root:Cannot call Open vSwitch: ovsdb-server.service is not running.                                                                          
[   22.116134] cloud-init[576]: ** (process:590): WARNING **: 08:35:34.356: Permissions for /etc/netplan/50-cloud-init.yaml are too open. Netplan configuration should NOT be accessi
ble by others.                                                                                                                                                                       
[   22.120060] cloud-init[576]: ** (process:590): WARNING **: 08:35:34.590: Permissions for /etc/netplan/50-cloud-init.yaml are too open. Netplan configuration should NOT be accessi
ble by others.                                                                                                                                                                       
[   22.123866] cloud-init[576]: ** (process:590): WARNING **: 08:35:34.591: Permissions for /etc/netplan/50-cloud-init.yaml are too open. Netplan configuration should NOT be accessi
ble by others.                                                                                                                                                                       
[   22.127606] cloud-init[576]: Failed to connect system bus: No such file or directory                                                                                              
[   22.129400] cloud-init[576]: WARNING:root:Falling back to a hard restart of systemd-networkd.service                                                                              
[   22.264892] cloud-init[576]: 2024-01-12 06:35:43,932 - schema.py[WARNING]: Invalid cloud-config provided: Please run 'sudo cloud-init schema --system' to see the schema errors.  
[  OK  ] Stopped Wait for Network to be Configured. 
```
 
I'm not sure if it is the NoCoud provider or Ubuntu that causes this issue but we try to handle it in the cloud-config.

Another issue, or rather feature, from running the Metadata Server is that the guest requires a DHCP (due to the nature of the guest communicating over IP), but we only use DHCP for bootstrap and then puts a static configuration in place.

### First boot / guest template 
Create a password hash, i.e. by typing:

``` 
pwdhash=$(openssl passwd -6)
```  

It is optional to create a template, but I felt that it was far too much time spent waiting and opted for a quicker way. Create a template similar to the following, according to your needs. Whatever you put in there stays in there.

What this does is that it creates a ZVOL backend, puts the cloud-image onto the raw disk, installs Kubernetes. Generates a cloud-init configuration to the NoCloud Metadata Server.

``` 
#!/usr/bin/env bash
guest=${1}
zpool=dpool
zfs create -V 10G -s -p ${zpool}/bhyve/${guest}/root
pv /var/tmp/jammy-server-cloudimg-amd64-disk-kvm.img.raw > /dev/zvol/${zpool}/bhyve/${guest}/root
uuid=$(uuidgen)
cinitdir=/var/tmp/cloud-init/${guest}
cinitip=192.168.168.1
certdir=/var/tmp/k8sbsd
sharedir=${certdir}/p9share/
mkdir -p ${cinitdir} ${sharedir}

bridge=bridge32
iface=${guest##*[^[:digit:]]}

ifconfig tap${iface} create up
ifconfig ${bridge} addm tap${iface}

cat << EOF > ${cinitdir}/meta-data
instance-id: ${uuid}
local-hostname: ${guest}
EOF

cat << EOF > ${cinitdir}/user-data
#cloud-config
users:
  - name: kubernaut
    gecos: Captain Kube
    primary_group: users
    groups: users
    shell: /bin/bash
    expiredate: '2029-12-31'
    lock_passwd: false
    sudo:  ALL=(ALL) NOPASSWD:ALL
    passwd: ${pwdhash}
bootcmd:
  - systemctl disable --now systemd-networkd-wait-online
ntp:
  enabled: true
timezone: Europe/Stockholm
manage_resolv_conf: true

mounts:
 - [ shared, /var/shared, 9p, "rw,relatime,dirsync,uname=root,cache=mmap,access=client,trans=virtio,_netdev", "0", "0" ]

resolv_conf:
  nameservers: ['9.9.9.9', '1.1.1.1']
  searchdomains:
    - cloud.mylocal
  domain: cloud.mylocal
  options:
    rotate: true
    timeout: 1
write_files:
  - path: /etc/sysctl.d/enabled_ipv4_forwarding.conf
    content: |
      net.ipv4.conf.all.forwarding=1
  - path: /etc/modules-load.d/crio.conf
    content: |
      overlay
      br_netfilter
  - path: /home/kubernaut/.bash_profile
    content: |
      if [ ! -f /usr/bin/resize ]; then
        resize() {
          old=$(stty -g)
          stty -echo
          printf '\033[18t'
          IFS=';' read -d t _ rows cols _
          stty "$old"
          stty cols "$cols" rows "$rows"
        }
      fi
      if [ "$(tty)" = "/dev/ttyS0" ]; then
         resize
      fi
    append: true
  - path: /root/.bash_profile
    content: |
      if [ ! -f /usr/bin/resize ]; then
        resize() {
          old=$(stty -g)
          stty -echo
          printf '\033[18t'
          IFS=';' read -d t _ rows cols _
          stty "$old"
          stty cols "$cols" rows "$rows"
        }
      fi
      if [ "$(tty)" = "/dev/ttyS0" ]; then
         resize
      fi
    append: true
  - path: /etc/sysctl.d/99-kubernetes-cri.conf
    content: |
      net.bridge.bridge-nf-call-iptables  = 1
      net.ipv4.ip_forward                 = 1
      net.bridge.bridge-nf-call-ip6tables = 1
  - path: /etc/sysctl.d/99-override_cilium_rp_filter.conf
    content: |
      net.ipv4.conf.lxc*.rp_filter = 0
  - path: /var/lib/kubelet/kubelet-config.yaml
    content: |
      kind: KubeletConfiguration
      apiVersion: kubelet.config.k8s.io/v1beta1
      cgroupDriver: systemd
      authentication:
        anonymous:
          enabled: false
        webhook:
          enabled: true
        x509:
          clientCAFile: "/var/lib/kubelet/ca.pem"
      authorization:
        mode: Webhook
      clusterDomain: "cluster.local"
      clusterDNS:
        - "10.96.0.10"
      resolvConf: "/run/systemd/resolve/resolv.conf"
      runtimeRequestTimeout: "15m"
      tlsCertFile: "/var/lib/kubelet/worker.pem"
      tlsPrivateKeyFile: "/var/lib/kubelet/worker-key.pem"
  - path: /etc/systemd/system/kubelet.service
    content: |
      [Unit]
      Description=Kubernetes Kubelet
      Documentation=https://github.com/kubernetes/kubernetes
      After=crio.service
      Requires=crio.service

      [Service]
      ExecStart=/usr/bin/kubelet \
        --config=/var/lib/kubelet/kubelet-config.yaml \
        --container-runtime-endpoint=/var/run/crio/crio.sock \
        --kubeconfig=/var/lib/kubelet/kubeconfig \
        --register-node=true \
        --v=2
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
runcmd:
  - modprobe overlay 
  - modprobe br_netfilter
  - sysctl --system 2>/dev/null
  - echo "deb [signed-by=/usr/share/keyrings/libcontainers-archive-keyring.gpg] https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_22.04/ /" > /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list
  - echo "deb [signed-by=/usr/share/keyrings/libcontainers-crio-archive-keyring.gpg] https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable:/cri-o:/1.28/xUbuntu_22.04/ /" > /etc/apt/sources.list.d/devel:kubic:libcontainers:stable:cri-o:1.28.list
  - mkdir -p /usr/share/keyrings /var/lib/kubelet
  - curl -L https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/xUbuntu_22.04/Release.key | gpg --dearmor -o /usr/share/keyrings/libcontainers-archive-keyring.gpg
  - curl -L https://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable:/cri-o:/1.28/xUbuntu_22.04/Release.key | gpg --dearmor -o /usr/share/keyrings/libcontainers-crio-archive-keyring.gpg
  - curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.29/deb/Release.key | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  - echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.29/deb/ /' | sudo tee /etc/apt/sources.list.d/kubernetes.list
  - export DEBIAN_FRONTEND=noninteractive KUBECONFIG=/etc/kubernetes/admin.conf
  - DEBIAN_FRONTEND=noninteractive apt-get update -q -y 
  - DEBIAN_FRONTEND=noninteractive apt-get install -y cri-o cri-o-runc apt-transport-https ca-certificates curl gnupg-agent software-properties-common jq golang-cfssl
  - systemctl daemon-reload
  - systemctl enable --now crio
  - DEBIAN_FRONTEND=noninteractive apt-get install -q -y kubelet=1.29.0-1.1 kubectl=1.29.0-1.1
  - DEBIAN_FRONTEND=noninteractive apt-mark hold kubelet kubectl
EOF

cat << EOF > ${guest}.cfg
acpi_tables=false
acpi_tables_in_memory=true
memory.size=4G
x86.strictmsr=true
x86.vmexit_on_hlt=true
lpc.fwcfg=bhyve
lpc.com1.path=stdio
lpc.bootrom=/usr/local/share/uefi-firmware/BHYVE_UEFI.fd
cpus=4
pci.0.0.0.device=hostbridge
pci.0.0.0.model=i440fx
pci.0.3.0.device=ahci
pci.0.4.0.device=virtio-blk
pci.0.4.0.path=/dev/zvol/dpool/bhyve/${guest}/root
pci.0.5.0.device=virtio-net
pci.0.5.0.backend=tap${iface}
pci.0.6.0.device=virtio-9p
pci.0.6.0.sharename=shared
pci.0.6.0.path=/var/tmp/k8sbsd/p9share
pci.0.30.0.device=fbuf
pci.0.30.0.vga=off
pci.0.30.0.unix=/tmp/${guest}.vnc
pci.0.30.1.device=xhci
pci.0.30.1.slot.1.device=tablet
pci.0.31.0.device=lpc
system.serial_number=ds=nocloud;s=http://${cinitip}:8000/${guest};i=${uuid}
name=${guest}
EOF

bhyve -k ${guest}.cfg
```

In a dedicated terminal (my recommendation is to utilize tmux, I've yet to understand how to escape from guests in FreeBSD. In illumos I run each bhyve guest in a dedicated non-global zone which in this case would correspond to a VNET jail. Maybe for later exercise to figure that out. Anyway, with tmux I found life in FreeBSD to be easier.

Boot the guest with a template name in the style of name+digit, i.e. worker0, as the argument to the script. This will create a tap interface with the same number.

As the guest is booting up the first time, login and become root and type the following, so that cloud-init will run again on the next boot:

```
cloud-init clean
systemctl poweroff
```

Then, create the snapshot and clone it:

```
zpool=dpool
zfs clone ${zpool}/bhyve/${guest}/root@init ${zpool}/bhyve/worker-init
zfs promote ${zpool}/bhyve/worker-init@init
```

### Create a worker node bootstrap script

The actual workers will be created out of a cloned snapshot. The cloud-init will be similar, but with some differences. In this template we start by creating a storage backend out of the clone. Then we will generate the certificates on the host and copy them to the shared file system (which we will consume by the guest during boot). Another thing we'll do, is that we'll replace the DHCP lease with a static address (this is very hackish, but it see to do the job and we want results without over achieving, right?!) and finally we configure the kubelet to the right configuration by utilizing the 9P file system. I think this is rather neat.

In a terminal (such as tmux), save the following and it as root:

```
#!/usr/bin/env bash
guest=${1}
zpool=dpool
cinitip=192.168.168.1
SSHKEY=<ssh-ed25519... > # optional SSH key

zfs create -p dpool/bhyve/${guest}
zfs clone dpool/bhyve/jammy-init@init dpool/bhyve/${guest}/root

uuid=$(uuidgen -r)
cinitdir=/var/tmp/cloud-init/${guest}
certdir=/var/tmp/k8sbsd
sharedir=${certdir}/p9share/
mkdir -p ${cinitdir} ${sharedir}

bridge=bridge32
iface=${guest##*[^[:digit:]]}

ifconfig tap${iface} create up
ifconfig ${bridge} addm tap${iface}

echo "192.168.168.2${iface} ${guest}" >> /opt/local/jails/containers/apiserv/etc/hosts

cp ${certdir}/kubernetes-ca/kubernetes-ca.pem ${sharedir}/ca.pem

cat << EOF > ${sharedir}/${guest}-csr.json
{ 
  "CN": "system:node:${guest}",
  "key": {
    "algo": "rsa",
    "size": 2048
  },  
  "hosts": [
    "${guest}",
    "192.168.168.2${iface}"
  ],
  "names": [
    { 
      "O": "system:nodes"
    }
  ]
}
EOF

cfssl gencert -ca=${certdir}/kubernetes-ca/kubernetes-ca.pem -ca-key=${certdir}/kubernetes-ca/kubernetes-ca-key.pem --config=${certdir}/kubernetes-ca/kubernetes-ca-config.json -profile=client -profile=kubelet ${sharedir}/${guest}-csr.json | cfssljson -bare ${sharedir}/${guest}
touch ${sharedir}/${guest}.kubeconfig
KUBECONFIG=${sharedir}/${guest}.kubeconfig kubectl config set-cluster default-cluster --server=https://192.168.168.10:6443 --certificate-authority ${certdir}/kubernetes-ca/kubernetes-ca.pem --embed-certs
KUBECONFIG=${sharedir}/${guest}.kubeconfig kubectl config set-credentials system:node:${guest} --client-key ${sharedir}/${guest}-key.pem --client-certificate ${sharedir}/${guest}.pem --embed-certs
KUBECONFIG=${sharedir}/${guest}.kubeconfig kubectl config set-context default-system --cluster default-cluster --user system:node:${guest}
KUBECONFIG=${sharedir}/${guest}.kubeconfig kubectl config use-context default-system

cat << EOF > ${cinitdir}/meta-data
instance-id: ${uuid}
local-hostname: ${guest}
EOF

cat << EOF > ${cinitdir}/user-data
#cloud-config
users:
  - name: kubernaut
    gecos: Captain Kube
    primary_group: users
    groups: users
    shell: /bin/bash
    ssh_authorized_keys: [ ${SSHKEY} ]
    expiredate: '2029-12-31'
    lock_passwd: false
    sudo:  ALL=(ALL) NOPASSWD:ALL
    passwd: ${pwdhash}
bootcmd:
  - systemctl disable --now systemd-networkd-wait-online
  - chmod og-r /etc/netplan/50-cloud-init.yaml
  - |
    sed -i 's/dhcp4\: true$/addresses:\n            - 192.168.168.2${iface}\/24\n            routes:\n            - to: default\n              via: 192.168.168.254\n            nameservers:\n              addresses:\n              - 1.1.1.1\n              - 8.8.8.8/g' /etc/netplan/50-cloud-init.yaml
  - netplan apply
ntp:
  enabled: true
timezone: Europe/Stockholm
manage_resolv_conf: true

mounts:
 - [ shared, /var/shared, 9p, "rw,relatime,dirsync,uname=root,cache=mmap,access=client,trans=virtio,_netdev", "0", "0" ]

resolv_conf:
  nameservers: ['9.9.9.9', '1.1.1.1']
  searchdomains:
    - cloud.mylocal
  domain: cloud.mylocal
  options:
    rotate: true
    timeout: 1
write_files:
  - path: /etc/sysctl.d/enabled_ipv4_forwarding.conf
    content: |
      net.ipv4.conf.all.forwarding=1
  - path: /etc/modules-load.d/crio.conf
    content: |
      overlay
      br_netfilter
  - path: /home/kubernaut/.bash_profile
    content: |
      if [ ! -f /usr/bin/resize ]; then
        resize() {
          old=\$(stty -g)
          stty -echo
          printf '\033[18t'
          IFS=';' read -d t _ rows cols _
          stty "\$old"
          stty cols "\$cols" rows "\$rows"
        }
      fi
      if [ "/dev/pts/8" = "/dev/ttyS0" ]; then
         resize
      fi
    append: true
  - path: /root/.bash_profile
    content: |
      if [ ! -f /usr/bin/resize ]; then
        resize() {
          old=\$(stty -g)
          stty -echo
          printf '\033[18t'
          IFS=';' read -d t _ rows cols _
          stty "\$old"
          stty cols "\$cols" rows "\$rows"
        }
      fi
      if [ "/dev/pts/8" = "/dev/ttyS0" ]; then
         resize
      fi
    append: true
  - path: /etc/sysctl.d/99-kubernetes-cri.conf
    content: |
      net.bridge.bridge-nf-call-iptables  = 1
      net.ipv4.ip_forward                 = 1
      net.bridge.bridge-nf-call-ip6tables = 1
  - path: /etc/sysctl.d/99-override_cilium_rp_filter.conf
    content: |
      net.ipv4.conf.lxc*.rp_filter = 0
  - path: /var/lib/kubelet/kubelet-config.yaml
    content: |
      kind: KubeletConfiguration
      apiVersion: kubelet.config.k8s.io/v1beta1
      cgroupDriver: systemd
      authentication:
        anonymous:
          enabled: false
        webhook:
          enabled: true
        x509:
          clientCAFile: "/var/lib/kubelet/ca.pem"
      authorization:
        mode: Webhook
      clusterDomain: "cluster.local"
      clusterDNS:
        - "10.96.0.10"
      resolvConf: "/run/systemd/resolve/resolv.conf"
      runtimeRequestTimeout: "15m"
      tlsCertFile: "/var/lib/kubelet/worker.pem"
      tlsPrivateKeyFile: "/var/lib/kubelet/worker-key.pem"
  - path: /etc/systemd/system/kubelet.service
    content: |
      [Unit]
      Description=Kubernetes Kubelet
      Documentation=https://github.com/kubernetes/kubernetes
      After=crio.service
      Requires=crio.service

      [Service]
      ExecStart=/usr/bin/kubelet \
        --config=/var/lib/kubelet/kubelet-config.yaml \
        --container-runtime-endpoint=/var/run/crio/crio.sock \
        --kubeconfig=/var/lib/kubelet/kubeconfig \
        --register-node=true \
        --v=2
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
runcmd:
  - ln -s /var/shared/ca.pem /var/lib/kubelet/ca.pem
  - ln -s /var/shared/\$(cat /etc/hostname).kubeconfig /var/lib/kubelet/kubeconfig
  - ln -s /var/shared/\$(cat /etc/hostname).pem /var/lib/kubelet/worker.pem
  - ln -s /var/shared/\$(cat /etc/hostname)-key.pem /var/lib/kubelet/worker-key.pem
  - systemctl restart kubelet
EOF

cat << EOF > ${guest}.cfg
acpi_tables=false
acpi_tables_in_memory=true
memory.size=4G
x86.strictmsr=true
x86.vmexit_on_hlt=true
lpc.fwcfg=bhyve
lpc.com1.path=stdio
lpc.bootrom=/usr/local/share/uefi-firmware/BHYVE_UEFI.fd
cpus=4
pci.0.0.0.device=hostbridge
pci.0.0.0.model=i440fx
pci.0.3.0.device=ahci
pci.0.4.0.device=virtio-blk
pci.0.4.0.path=/dev/zvol/dpool/bhyve/${guest}/root
pci.0.5.0.device=virtio-net
pci.0.5.0.backend=tap${iface}
pci.0.6.0.device=virtio-9p
pci.0.6.0.sharename=shared
pci.0.6.0.path=/var/tmp/k8sbsd/p9share
pci.0.31.0.device=lpc
system.serial_number=ds=nocloud;s=http://${cinitip}:8000/${guest};i=${uuid}
name=${guest}
EOF

bhyve -k ${guest}.cfg
```

## Finally, bootstrapping worker nodes


### Bootstrap one worker node


```
./create_worker.sh worker1
```

Within some 15–60 seconds (? depending on hardware and communications), a worker node should be up and running.

```
/var/tmp/k8sbsd]# kubectl get nodes
NAME      STATUS   ROLES    AGE   VERSION
worker1   Ready    <none>   2s    v1.29.0
```

### Bootstrap some more worker nodes

In new terminals, repeat the bootstrap to have some more worker nodes. I believe that I should checkout the `cu` command for that console handling as a future exercise.

### Install Core DNS

Verify that the gsed is installed (or adapt the sed):

```
curl -s https://raw.githubusercontent.com/coredns/deployment/master/kubernetes/coredns.yaml.sed | gsed '/^\s*forward . UPSTREAMNAMESERVER {$/{:a;N;/^\s*}$/M!ba;d};s/CLUSTER_DNS_IP/10.96.0.10/g;s/CLUSTER_DOMAIN REVERSE_CIDRS/cluster.local in-addr.arpa ip6.arpa/g;s/}STUBDOMAINS/}/g;s/# replicas:/replicas: 2 #/g' |kubectl create -f -
```

### Install Cilium

Either compile helm or cilium-cli commands (but the Cilium CLI command is to prefer as it also benefits from useful features around status and is a neat tool to have.

```
cilium version
cilium-cli: v0.15.19 compiled with go1.21.5 on freebsd/amd64
cilium image (default): v1.14.4
cilium image (stable): v1.14.5
cilium image (running): 1.14.5
```

Install Cilium CNI in the kube-proxy free setup (as we don't have any kube-proxy at all in place). 

```
cilium install --version 1.14.5 \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=192.168.168.10 \
  --set k8sServicePort=6443 \  
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true # --wait (optionally)
```

Some two minutes the cluster is installed, and check the status with the `cilium status` command:

```
cilium status
    /¯¯\
 /¯¯\__/¯¯\    Cilium:             OK
 \__/¯¯\__/    Operator:           OK
 /¯¯\__/¯¯\    Envoy DaemonSet:    disabled (using embedded mode)
 \__/¯¯\__/    Hubble Relay:       OK
    \__/       ClusterMesh:        disabled

Deployment             hubble-ui          Desired: 1, Ready: 1/1, Available: 1/1
Deployment             cilium-operator    Desired: 1, Ready: 1/1, Available: 1/1
Deployment             hubble-relay       Desired: 1, Ready: 1/1, Available: 1/1
DaemonSet              cilium             Desired: 2, Ready: 2/2, Available: 2/2
Containers:            cilium             Running: 2
                       hubble-ui          Running: 1
                       cilium-operator    Running: 1
                       hubble-relay       Running: 1
Cluster Pods:          4/4 managed by Cilium
Helm chart version:    1.14.5
Image versions         cilium             quay.io/cilium/cilium:v1.14.5@sha256:d3b287029755b6a47dee01420e2ea469469f1b174a2089c10af7e5e9289ef05b: 2
                       hubble-ui          quay.io/cilium/hubble-ui-backend:v0.12.1@sha256:1f86f3400827a0451e6332262467f894eeb7caf0eb8779bd951e2caa9d027cbe: 1
                       hubble-ui          quay.io/cilium/hubble-ui:v0.12.1@sha256:9e5f81ee747866480ea1ac4630eb6975ff9227f9782b7c93919c081c33f38267: 1
                       cilium-operator    quay.io/cilium/operator-generic:v1.14.5@sha256:303f9076bdc73b3fc32aaedee64a14f6f44c8bb08ee9e3956d443021103ebe7a: 1
                       hubble-relay       quay.io/cilium/hubble-relay:v1.14.5@sha256:dbef89f924a927043d02b40c18e417c1ea0e8f58b44523b80fef7e3652db24d4: 1
```

### Hubble observations

If the worker nodes are reachable, you should be able to patch the hubble-ui Service and reach Hubble UI on a NodePort (a high port on a worker node) by patching the Service:

```
kubectl -n kube-system patch svc/hubble-ui -p '{"spec": {"type": "NodePort"}}'
```

Not much happenings in there though:
![Hubble Web UI - observation of the traffic into Hubble.](/assets/freebsd-hubble.png)*<p align=center>Hubble Web UI - observation of the traffic into Hubble.</p>*


Or, if you (as me) have compiled the Hubble CLI:

```
kubectl port-forward -n kube-system svc/hubble-relay 4245:80 &
[1] 38838
[root@beast /var/tmp/k8sbsd]# Forwarding from 127.0.0.1:4245 -> 4245
Forwarding from [::1]:4245 -> 4245
hubble observe -n kube-system
Handling connection for 4245
Jan 02 07:38:09.681: 127.0.0.1:59698 (world) <> kube-system/coredns-7fd867d5c-t8h8m (ID:46775) pre-xlate-rev TRACED (TCP)
Jan 02 07:38:10.680: 127.0.0.1:59700 (world) <> kube-system/coredns-7fd867d5c-t8h8m (ID:46775) pre-xlate-rev TRACED (TCP)
Jan 02 07:38:10.681: 127.0.0.1:8080 (world) <> kube-system/coredns-7fd867d5c-t8h8m (ID:46775) pre-xlate-rev TRACED (TCP)
Jan 02 07:38:11.233: kube-system/hubble-relay-565664bf9f-n5j4v:56128 (ID:9981) -> 192.168.168.21:4244 (host) to-stack FORWARDED (TCP Flags: ACK)
Jan 02 07:38:11.233: kube-system/hubble-relay-565664bf9f-n5j4v:56128 (ID:9981) <- 192.168.168.21:4244 (host) to-endpoint FORWARDED (TCP Flags: ACK)
Jan 02 07:38:11.558: kube-system/hubble-ui-6f48889749-nttn8:40432 (ID:9425) -> kube-system/hubble-relay-565664bf9f-n5j4v:4245 (ID:9981) to-endpoint FORWARDED (TCP Flags: ACK, PSH)
Jan 02 07:38:11.559: kube-system/hubble-ui-6f48889749-nttn8:40432 (ID:9425) <- kube-system/hubble-relay-565664bf9f-n5j4v:4245 (ID:9981) to-endpoint FORWARDED (TCP Flags: ACK, PSH)
```

Or, if you only check at the cilium-agent (but be aware, it will be local to the node running the agent):

```
kubectl -n kube-system exec ds/cilium -it -- hubble observe -n kube-system
Defaulted container "cilium-agent" out of: cilium-agent, config (init), mount-cgroup (init), apply-sysctl-overwrites (init), mount-bpf-fs (init), clean-cilium-state (init), install-cni-binaries (init)
Jan 02 07:40:55.550: 10.0.1.178:55564 (world) -> kube-system/hubble-ui-6f48889749-nttn8:8081 (ID:9425) to-overlay FORWARDED (TCP Flags: ACK)
Jan 02 07:40:55.556: 10.0.1.178:55564 (world) -> kube-system/hubble-ui-6f48889749-nttn8:8081 (ID:9425) to-overlay FORWARDED (TCP Flags: ACK)
Jan 02 07:40:55.654: 127.0.0.1:8080 (world) <> kube-system/coredns-7fd867d5c-hsmk9 (ID:46775) pre-xlate-rev TRACED (TCP)
Jan 02 07:40:55.654: 127.0.0.1:56818 (world) <> kube-system/coredns-7fd867d5c-hsmk9 (ID:46775) pre-xlate-rev TRACED (TCP)
Jan 02 07:40:56.654: 127.0.0.1:8080 (world) <> kube-system/coredns-7fd867d5c-hsmk9 (ID:46775) pre-xlate-rev TRACED (TCP)
```

### Demo applications

Try the https://docs.cilium.io/en/stable/gettingstarted/demo/#starwars-demo

You can't tell by the output if it was taken from the documentation or live:

```
kubectl create -f https://raw.githubusercontent.com/cilium/cilium/1.14.5/examples/minikube/http-sw-app.yaml
service/deathstar created
deployment.apps/deathstar created
pod/tiefighter created
pod/xwing created
```

But it was live:

```
kubectl version -o json
{
  "clientVersion": {
    "major": "1",
    "minor": "29+",
    "gitVersion": "v1.29.0-1+d15af86e9e661f",
    "gitCommit": "d15af86e9e661f5031d904ebcc0dfbf2cb3d2117",
    "gitTreeState": "clean",
    "buildDate": "2023-12-13T20:19:35Z",
    "goVersion": "go1.21.5",
    "compiler": "gc",
    "platform": "freebsd/amd64"
  },
  "kustomizeVersion": "v5.0.4-0.20230601165947-6ce0bf390ce3",
  "serverVersion": {
    "major": "1",
    "minor": "29+",
    "gitVersion": "v1.29.0-1+d15af86e9e661f",
    "gitCommit": "d15af86e9e661f5031d904ebcc0dfbf2cb3d2117",
    "gitTreeState": "clean",
    "buildDate": "2023-12-13T20:20:25Z",
    "goVersion": "go1.21.5",
    "compiler": "gc",
    "platform": "freebsd/amd64"
  }
}
```

### Restrictions and limitations

Basically anything that requires a dynamic admission controller would be expected to fail, as the kube-apiserver does not really know how to reach a ClusterIP. I've written a little about it before, but one way to solve it is by exposing the ClusterIP and then help the apiserver with some advanced routing (BGP). Another way is to patch the mutating and validating admission controllers so that the services are externally reachable.

As I mentioned in the video, this is just at an experimental stage and far from being official acknowledged and the conformance testing complains on a couple of tests - but that doesn't stop it from being useful (and fun!). Just be aware of the limitations.

In a planned third part I'll cover the routing so that admission controllers expects to work as well..

### YouTube appearance
I'm not that OBS savy (yet), and while the demo went (relatively) smoothly it was my second attempt - during the first day of 2024. My first attempt happened on the very last day of 2023 and I felt satisfied when I pressed stop as I had to go through some troubleshooting which I resolved. Then, looking though the result - everything was LTRIM() and missing the first character in every line from the terminal, ha ha. I wanted to do my video in 2023, but I had better things to do on that very day.

My first video was made in three attempts due to bad resolution in the first attempt, frozen picture on the second. My third video might end up well on the first attempt…
